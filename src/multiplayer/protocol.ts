// Wire protocol shared by the room Durable Object, the host (presenter) view, and player clients.
// The host is authoritative: it runs every submitted driver and computes scores. The room server
// relays code to hosts and results back to players. Before relaying, it test-drives each submission
// in an isolated Dynamic Worker (worker/validator.ts) and rejects drivers that would spoil the race.

export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_PLAYER_NAME_LENGTH = 24;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = MAX_SOURCE_BYTES + 4 * 1024;
export const MIN_SUBMIT_INTERVAL_MS = 3000;
/**
 * The presenter steps every car every 22 ms. Simulation alone measured ~8 ms per step (p95 ~12 ms)
 * at 50 players, plus each driver's sandbox round trip.
 */
export const MAX_PLAYERS_PER_ROOM = 50;

export type RoundPhase = 'lobby' | 'racing' | 'intermission';

/** What the presenter currently lets players see. */
export interface PresentationState {
  /** Toolbox snippet ids hidden from players' toolbox menus. */
  lockedHelpers: string[];
}

/** New rooms start with the ready-made answers locked, so the presenter can reveal them. */
export const DEFAULT_PRESENTATION: PresentationState = {
  lockedHelpers: ['adaptive-cruise', 'fastest-lane', 'lateral-velocity'],
};

const MAX_LOCKED_HELPERS = 32;

export interface RoundState {
  phase: RoundPhase;
  round: number;
  /** Epoch milliseconds when the current phase ends, if timed. */
  endsAt?: number;
  /** Driver version each player is racing with in the current round. */
  racingVersions?: Record<string, number>;
}

export interface PlayerSummary {
  id: string;
  name: string;
  connected: boolean;
  /** Latest submitted driver version, if any. */
  version?: number;
  submittedAt?: number;
}

export interface RoundResult {
  round: number;
  distance: number;
  collisions: number;
  atFaultCollisions: number;
  edgeHits: number;
  points: number;
  place: number;
  finishedRacers: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  totalPoints: number;
  bestRoundPoints: number;
  roundsRaced: number;
  totalAtFault: number;
  lastRound?: RoundResult;
}

export type DriverStatus = 'queued' | 'ready' | 'racing' | 'error';

export interface DriverStatusUpdate {
  playerId: string;
  version: number;
  status: DriverStatus;
  message?: string;
}

/** Measurements from the pre-race test drive every submission must pass. See validation.ts. */
export interface ValidationMetrics {
  simulatedSeconds: number;
  distance: number;
  /** Average speed after warmup, in m/s. */
  averageSpeed: number;
  /** Share of post-warmup time spent slow with nothing ahead holding the car back. */
  blockingFraction: number;
  collisions: number;
  atFaultCollisions: number;
  failedSteps: number;
}

export type ValidationCheck = 'blocking' | 'collisions' | 'errors' | 'compile' | 'timeout' | 'unavailable';

export interface ValidationIssue {
  check: ValidationCheck;
  message: string;
}

export interface ValidationReport {
  passed: boolean;
  issues: ValidationIssue[];
  metrics?: ValidationMetrics;
  /** First error the driver threw, if any. */
  firstError?: string;
}

// ---- Player -> server ----
export type PlayerToServerMessage = { type: 'submit'; source: string } | { type: 'ping' };

// ---- Host -> server ----
export type HostToServerMessage =
  | { type: 'round-state'; state: RoundState }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | ({ type: 'driver-status' } & DriverStatusUpdate)
  | { type: 'presentation'; state: PresentationState }
  | { type: 'ping' };

// ---- Server -> player ----
export type ServerToPlayerMessage =
  | {
      type: 'welcome';
      playerId: string;
      name: string;
      roomCode: string;
      round: RoundState;
      presentation: PresentationState;
      version?: number;
      /** True while a submission from this player is still being test-driven. */
      validating?: boolean;
    }
  /** The submission is being test-driven. `queuedBehind` counts validations that must finish first. */
  | { type: 'submission-validating'; queuedBehind: number }
  | { type: 'submission-accepted'; version: number; submittedAt: number; report: ValidationReport }
  /** The submission failed its test drive and was not sent to the race. The previous version keeps racing. */
  | { type: 'submission-rejected'; report: ValidationReport }
  | { type: 'round-state'; state: RoundState }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | ({ type: 'driver-status' } & DriverStatusUpdate)
  | { type: 'presentation'; state: PresentationState }
  | { type: 'error'; message: string }
  | { type: 'pong' };

// ---- Server -> host ----
export type ServerToHostMessage =
  | {
      type: 'room';
      roomCode: string;
      players: PlayerSummary[];
      round: RoundState;
      leaderboard: LeaderboardEntry[];
      presentation: PresentationState;
    }
  | { type: 'player'; player: PlayerSummary }
  | { type: 'submission'; playerId: string; version: number; submittedAt: number; source: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface CreateRoomResponse {
  roomCode: string;
  hostToken: string;
}

export interface JoinRoomRequest {
  name: string;
  playerId?: string;
  playerToken?: string;
}

export interface JoinRoomResponse {
  playerId: string;
  playerToken: string;
  name: string;
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false;
  for (const character of value) if (!ROOM_CODE_ALPHABET.includes(character)) return false;
  return true;
}

export function sanitizePlayerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Strip control and bidi-override characters so names cannot spoof the presenter screen.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('');
  return name.length > 0 ? name : undefined;
}

export function parsePlayerMessage(value: unknown): PlayerToServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'ping') return { type: 'ping' };
  if (value.type === 'submit' && typeof value.source === 'string') return { type: 'submit', source: value.source };
  return undefined;
}

export function parseHostMessage(value: unknown): HostToServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'ping':
      return { type: 'ping' };
    case 'round-state': {
      const state = parseRoundState(value.state);
      return state ? { type: 'round-state', state } : undefined;
    }
    case 'presentation': {
      const state = parsePresentationState(value.state);
      return state ? { type: 'presentation', state } : undefined;
    }
    case 'leaderboard': {
      if (!Array.isArray(value.entries) || value.entries.length > MAX_PLAYERS_PER_ROOM) return undefined;
      const entries = value.entries.map(parseLeaderboardEntry);
      return entries.every(Boolean) ? { type: 'leaderboard', entries: entries as LeaderboardEntry[] } : undefined;
    }
    case 'driver-status': {
      const status = value.status;
      if (
        typeof value.playerId !== 'string' ||
        !isFiniteNumber(value.version) ||
        (status !== 'queued' && status !== 'ready' && status !== 'racing' && status !== 'error')
      ) {
        return undefined;
      }
      return {
        type: 'driver-status',
        playerId: value.playerId,
        version: value.version,
        status,
        message: typeof value.message === 'string' ? value.message.slice(0, 2000) : undefined,
      };
    }
    default:
      return undefined;
  }
}

export function parsePresentationState(value: unknown): PresentationState | undefined {
  if (!isRecord(value) || !Array.isArray(value.lockedHelpers) || value.lockedHelpers.length > MAX_LOCKED_HELPERS) return undefined;
  const lockedHelpers = value.lockedHelpers.filter(
    (id): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id),
  );
  return { lockedHelpers: [...new Set(lockedHelpers)] };
}

function parseRoundState(value: unknown): RoundState | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.round)) return undefined;
  if (value.phase !== 'lobby' && value.phase !== 'racing' && value.phase !== 'intermission') return undefined;
  let racingVersions: Record<string, number> | undefined;
  if (isRecord(value.racingVersions)) {
    racingVersions = {};
    for (const [id, version] of Object.entries(value.racingVersions).slice(0, MAX_PLAYERS_PER_ROOM)) {
      if (isFiniteNumber(version)) racingVersions[id] = version;
    }
  }
  return {
    phase: value.phase,
    round: value.round,
    endsAt: isFiniteNumber(value.endsAt) ? value.endsAt : undefined,
    racingVersions,
  };
}

function parseRoundResult(value: unknown): RoundResult | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ['round', 'distance', 'collisions', 'atFaultCollisions', 'points', 'place', 'finishedRacers'] as const;
  if (!fields.every((field) => isFiniteNumber(value[field]))) return undefined;
  return {
    ...(Object.fromEntries(fields.map((field) => [field, value[field]])) as Omit<RoundResult, 'edgeHits'>),
    edgeHits: isFiniteNumber(value.edgeHits) ? value.edgeHits : 0,
  };
}

function parseLeaderboardEntry(value: unknown): LeaderboardEntry | undefined {
  if (!isRecord(value) || typeof value.playerId !== 'string') return undefined;
  const name = sanitizePlayerName(value.name);
  const numbers = ['totalPoints', 'bestRoundPoints', 'roundsRaced', 'totalAtFault'] as const;
  if (!name || !numbers.every((field) => isFiniteNumber(value[field]))) return undefined;
  const lastRound = value.lastRound === undefined ? undefined : parseRoundResult(value.lastRound);
  if (value.lastRound !== undefined && !lastRound) return undefined;
  return {
    playerId: value.playerId,
    name,
    totalPoints: value.totalPoints as number,
    bestRoundPoints: value.bestRoundPoints as number,
    roundsRaced: value.roundsRaced as number,
    totalAtFault: value.totalAtFault as number,
    lastRound,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
