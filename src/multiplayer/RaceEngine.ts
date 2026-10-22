import type { RenderSnapshot } from '../rendering';
import { CompilerClient, SandboxClient } from '../sandbox';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP, Simulation, type PlayerRaceState } from '../simulation';
import { SeededRandom } from '../simulation/random';
import type { PlaygroundSettings } from '../types';
import type { DriverStatusUpdate, LeaderboardEntry, PlayerSummary, RoundPhase, RoundResult, RoundState } from './protocol';
import { RACE_SCORING, applyRoundResults, roundPoints, scoreRound, sortLeaderboard } from './scoring';

const MAX_STEPS_PER_TICK = 4;
const DRIVER_TIMEOUT_MS = 28;
/** A driver that blows its frame budget this many steps in a row is benched until the next round. */
const MAX_CONSECUTIVE_TIMEOUTS = 30;

export const PLAYER_COLORS = [
  '#ff5a5f', '#ffb400', '#00c2a8', '#3d8bff', '#b15cff', '#ff7ac6', '#7ed957', '#ff8a3d',
  '#2ed3ff', '#ffd23f', '#e84393', '#00b894', '#6c5ce7', '#fd79a8', '#55efc4', '#fab1a0',
];

export interface RaceConfig {
  roundSeconds: number;
  intermissionSeconds: number;
  trafficDensity: number;
  autoAdvance: boolean;
}

export const DEFAULT_RACE_CONFIG: RaceConfig = {
  roundSeconds: 90,
  intermissionSeconds: 12,
  trafficDensity: 0.45,
  autoAdvance: true,
};

export interface RaceCallbacks {
  onDriverStatus(update: DriverStatusUpdate): void;
  onRoundState(state: RoundState): void;
  onLeaderboard(entries: LeaderboardEntry[]): void;
}

export interface DriverView {
  playerId: string;
  name: string;
  color: string;
  connected: boolean;
  submittedVersion?: number;
  readyVersion?: number;
  status: DriverStatusUpdate['status'] | 'waiting';
  message?: string;
}

export interface LiveStanding {
  playerId: string;
  name: string;
  color: string;
  distance: number;
  points: number;
  collisions: number;
  atFaultCollisions: number;
  stalled: boolean;
  benched: boolean;
}

interface CompiledDriver {
  version: number;
  js: string;
}

interface Driver {
  playerId: string;
  name: string;
  color: string;
  connected: boolean;
  submittedVersion?: number;
  compiled?: CompiledDriver;
  status: DriverView['status'];
  message?: string;
  sandbox?: SandboxClient;
  loadedVersion?: number;
}

interface Racer {
  driver: Driver;
  version: number;
  timeouts: number;
  benched: boolean;
  errorReported: boolean;
}

/**
 * Runs the authoritative race on the presenter's machine: compiles submissions, executes each driver
 * in its own sandboxed iframe worker, steps one shared simulation, and scores rounds.
 */
export class RaceEngine {
  config: RaceConfig = { ...DEFAULT_RACE_CONFIG };
  phase: RoundPhase = 'lobby';
  round = 0;
  paused = false;
  leaderboard: LeaderboardEntry[] = [];
  lastResults = new Map<string, RoundResult>();

  private readonly drivers = new Map<string, Driver>();
  private readonly compiler = new CompilerClient();
  private simulation?: Simulation;
  private settings: PlaygroundSettings = raceSettings(0, DEFAULT_RACE_CONFIG.trafficDensity);
  private racers: Racer[] = [];
  private accumulator = 0;
  private intermissionEndsAt = 0;
  private stepping = false;
  private disposed = false;
  private transitioning = false;

  constructor(private readonly callbacks: RaceCallbacks) {}

  dispose(): void {
    this.disposed = true;
    this.compiler.dispose();
    for (const driver of this.drivers.values()) driver.sandbox?.dispose();
  }

  restore(round: RoundState, leaderboard: LeaderboardEntry[]): void {
    this.round = Math.max(this.round, round.round);
    this.leaderboard = sortLeaderboard(leaderboard);
  }

  upsertPlayer(summary: PlayerSummary): void {
    const driver = this.drivers.get(summary.id);
    if (driver) {
      driver.name = summary.name;
      driver.connected = summary.connected;
      return;
    }
    const used = new Set([...this.drivers.values()].map((existing) => existing.color));
    this.drivers.set(summary.id, {
      playerId: summary.id,
      name: summary.name,
      color: PLAYER_COLORS.find((color) => !used.has(color)) ?? colorForPlayer(summary.id),
      connected: summary.connected,
      status: 'waiting',
    });
  }

  async submit(playerId: string, version: number, source: string): Promise<void> {
    const driver = this.drivers.get(playerId);
    if (!driver || (driver.submittedVersion !== undefined && version <= driver.submittedVersion)) return;
    driver.submittedVersion = version;

    let result;
    try {
      result = await this.compiler.compile(source);
    } catch (error) {
      result = { ok: false, js: '', errors: [formatError(error)] };
    }
    if (this.disposed || driver.submittedVersion !== version) return;

    if (!result.ok) {
      this.setStatus(driver, version, 'error', `Version ${version} did not compile:\n${result.errors.slice(0, 5).join('\n')}`);
      return;
    }
    driver.compiled = { version, js: result.js };
    this.setStatus(
      driver,
      version,
      this.phase === 'racing' ? 'queued' : 'ready',
      this.phase === 'racing' ? 'Compiled. It will race when the next round starts.' : 'Compiled and ready for the next round.',
    );
  }

  driverViews(): DriverView[] {
    return [...this.drivers.values()].map((driver) => ({
      playerId: driver.playerId,
      name: driver.name,
      color: driver.color,
      connected: driver.connected,
      submittedVersion: driver.submittedVersion,
      readyVersion: driver.compiled?.version,
      status: driver.status,
      message: driver.message,
    }));
  }

  get readyDriverCount(): number {
    return [...this.drivers.values()].filter((driver) => driver.compiled).length;
  }

  get timeRemaining(): number {
    if (this.phase === 'racing' && this.simulation) return Math.max(0, this.config.roundSeconds - this.simulation.currentTime);
    if (this.phase === 'intermission') return Math.max(0, (this.intermissionEndsAt - Date.now()) / 1000);
    return 0;
  }

  /** Simulated seconds the race is behind the wall clock. */
  get backlogSeconds(): number {
    return this.phase === 'racing' && !this.paused ? this.accumulator : 0;
  }

  get racerIds(): string[] {
    return this.racers.map((racer) => racer.driver.playerId);
  }

  playerName(id: string): string | undefined {
    return this.drivers.get(id)?.name;
  }

  playerColor(id: string): string {
    return this.drivers.get(id)?.color ?? colorForPlayer(id);
  }

  liveStandings(): LiveStanding[] {
    if (!this.simulation) return [];
    const racers = new Map(this.racers.map((racer) => [racer.driver.playerId, racer]));
    return this.simulation
      .getPlayerStates()
      .map((state) => {
        const racer = racers.get(state.id)!;
        return {
          playerId: state.id,
          name: racer.driver.name,
          color: racer.driver.color,
          distance: state.distance,
          points: roundPoints(state),
          collisions: state.collisions,
          atFaultCollisions: state.atFaultCollisions,
          stalled: state.stalled,
          benched: racer.benched,
        };
      })
      .sort((a, b) => b.points - a.points);
  }

  playerStates(): PlayerRaceState[] {
    return this.simulation?.getPlayerStates() ?? [];
  }

  snapshot(view: { centerS: number; behindMeters: number; aheadMeters: number }): RenderSnapshot | undefined {
    return this.simulation?.getSnapshot(this.settings, view);
  }

  async startRound(): Promise<void> {
    if (this.transitioning || this.disposed) return;
    this.transitioning = true;
    try {
      const candidates = [...this.drivers.values()].filter((driver) => driver.compiled);
      if (candidates.length === 0) {
        this.enterLobby();
        return;
      }

      const loaded = await Promise.all(candidates.map((driver) => this.prepareSandbox(driver)));
      const ready = candidates.filter((_, index) => loaded[index]);
      if (this.disposed) return;
      if (ready.length === 0) {
        this.enterLobby();
        return;
      }

      this.round += 1;
      const order = shuffled(ready, new SeededRandom(this.round * 7919 + 17));
      this.racers = order.map((driver) => ({
        driver,
        version: driver.loadedVersion!,
        timeouts: 0,
        benched: false,
        errorReported: false,
      }));
      this.settings = raceSettings(this.round, this.config.trafficDensity);
      this.simulation = new Simulation(this.settings, {
        players: order.map((driver) => ({ id: driver.playerId, color: driver.color })),
        atFaultStallSeconds: RACE_SCORING.atFaultStallSeconds,
      });
      this.accumulator = 0;
      this.phase = 'racing';
      this.paused = false;
      for (const racer of this.racers) {
        this.setStatus(racer.driver, racer.version, 'racing', `Racing version ${racer.version} in round ${this.round}.`);
      }
      this.broadcastRoundState();
    } finally {
      this.transitioning = false;
    }
  }

  endRound(): void {
    if (this.phase !== 'racing' || !this.simulation) return;
    this.lastResults = scoreRound(this.round, this.simulation.getPlayerStates());
    const names = new Map([...this.drivers.values()].map((driver) => [driver.playerId, driver.name]));
    this.leaderboard = applyRoundResults(this.leaderboard, this.lastResults, names);
    this.callbacks.onLeaderboard(this.leaderboard);

    for (const racer of this.racers) {
      const driver = racer.driver;
      if (driver.status === 'racing') this.setStatus(driver, racer.version, 'ready', 'Waiting for the next round.');
    }
    for (const driver of this.drivers.values()) {
      if (driver.status === 'queued' && driver.compiled) {
        this.setStatus(driver, driver.compiled.version, 'ready', 'Compiled and ready for the next round.');
      }
    }

    this.phase = 'intermission';
    this.intermissionEndsAt = Date.now() + this.config.intermissionSeconds * 1000;
    this.broadcastRoundState();
  }

  setPaused(paused: boolean): void {
    if (this.phase !== 'racing') return;
    this.paused = paused;
    this.accumulator = 0;
    this.broadcastRoundState();
  }

  enterLobby(): void {
    this.phase = 'lobby';
    this.paused = false;
    this.broadcastRoundState();
  }

  /** Re-sends state the room server may have missed while the host was disconnected. */
  resync(): void {
    this.broadcastRoundState();
    this.callbacks.onLeaderboard(this.leaderboard);
  }

  resetLeaderboard(): void {
    this.leaderboard = [];
    this.lastResults = new Map();
    this.callbacks.onLeaderboard(this.leaderboard);
  }

  /** Advances the race by wall-clock `elapsed` seconds. Overlapping calls only add to the backlog. */
  async tick(elapsed: number): Promise<void> {
    // Accumulate even while a previous tick is still awaiting drivers so simulated time keeps up.
    if (this.phase === 'racing' && !this.paused) this.accumulator = Math.min(0.25, this.accumulator + elapsed);
    if (this.stepping || this.disposed) return;
    this.stepping = true;
    try {
      if (this.phase === 'intermission' && this.config.autoAdvance && Date.now() >= this.intermissionEndsAt) {
        await this.startRound();
        return;
      }
      if (this.phase !== 'racing' || this.paused || !this.simulation) return;

      let steps = 0;
      while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_TICK) {
        await this.step(this.simulation);
        if (this.disposed || this.phase !== 'racing') return;
        this.accumulator -= FIXED_TIMESTEP;
        steps += 1;
        if (this.simulation.currentTime >= this.config.roundSeconds) {
          this.endRound();
          return;
        }
      }
    } finally {
      this.stepping = false;
    }
  }

  private async step(simulation: Simulation): Promise<void> {
    const runs = this.racers.map(async (racer) => {
      const id = racer.driver.playerId;
      const input = simulation.createPlayerInput(id, this.settings, FIXED_TIMESTEP);
      if (racer.benched || !racer.driver.sandbox) return [id, undefined] as const;
      try {
        const result = await racer.driver.sandbox.run(input, DRIVER_TIMEOUT_MS, false);
        racer.timeouts = 0;
        return [id, result.output] as const;
      } catch (error) {
        this.handleRunError(racer, error);
        return [id, undefined] as const;
      }
    });
    const outputs = new Map<string, unknown>(await Promise.all(runs));
    simulation.stepPlayers(FIXED_TIMESTEP, outputs, this.settings);
  }

  private handleRunError(racer: Racer, error: unknown): void {
    const message = formatError(error);
    if (/timed out|frame budget/i.test(message)) {
      racer.timeouts += 1;
      if (racer.timeouts >= MAX_CONSECUTIVE_TIMEOUTS && !racer.benched) {
        racer.benched = true;
        this.setStatus(
          racer.driver,
          racer.version,
          'error',
          `Your driver kept exceeding its ${DRIVER_TIMEOUT_MS} ms time budget, so it is coasting for the rest of round ${this.round}.`,
        );
      }
      return;
    }
    if (racer.errorReported) return;
    racer.errorReported = true;
    this.setStatus(racer.driver, racer.version, 'error', `Runtime error in round ${this.round} (car coasts while it throws):\n${message}`);
  }

  private async prepareSandbox(driver: Driver): Promise<boolean> {
    const compiled = driver.compiled!;
    try {
      if (!driver.sandbox) driver.sandbox = new SandboxClient('/sandbox.html');
      if (driver.loadedVersion !== compiled.version) {
        await driver.sandbox.loadCode(compiled.js);
        driver.loadedVersion = compiled.version;
      }
      return true;
    } catch (error) {
      driver.sandbox?.dispose();
      driver.sandbox = undefined;
      driver.loadedVersion = undefined;
      driver.compiled = undefined;
      this.setStatus(driver, compiled.version, 'error', `Version ${compiled.version} failed to load:\n${formatError(error)}`);
      return false;
    }
  }

  private setStatus(driver: Driver, version: number, status: DriverStatusUpdate['status'], message?: string): void {
    driver.status = status;
    driver.message = message;
    this.callbacks.onDriverStatus({ playerId: driver.playerId, version, status, message });
  }

  private broadcastRoundState(): void {
    const endsAt =
      this.phase === 'racing' && !this.paused
        ? Date.now() + this.timeRemaining * 1000
        : this.phase === 'intermission'
          ? this.intermissionEndsAt
          : undefined;
    this.callbacks.onRoundState({
      phase: this.phase,
      round: this.round,
      endsAt,
      racingVersions:
        this.phase === 'racing'
          ? Object.fromEntries(this.racers.map((racer) => [racer.driver.playerId, racer.version]))
          : undefined,
    });
  }
}

export function raceSettings(round: number, trafficDensity: number): PlaygroundSettings {
  return {
    ...DEFAULT_SETTINGS,
    seed: 1000 + round * 37,
    trafficDensity,
    startingSpeed: 20,
    noisyLaneLines: true,
    noisyVehicles: true,
    actuatorVariation: true,
    debugOverlays: false,
    steerAssist: false,
    accelerateAssist: false,
  };
}

export function colorForPlayer(id: string): string {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PLAYER_COLORS[(hash >>> 0) % PLAYER_COLORS.length];
}

function shuffled<T>(items: T[], rng: SeededRandom): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/sandbox|worker/gi, 'code runner');
}
