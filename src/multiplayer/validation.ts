import { FIXED_TIMESTEP, Simulation } from '../simulation';
import type { AutopilotInput } from '../types';
import type { ValidationIssue, ValidationMetrics, ValidationReport } from './protocol';
import { raceSettings } from './raceSettings';
import { RACE_SCORING } from './scoring';

/**
 * Pre-race check for submitted drivers. Each submission drives a short solo run in race conditions
 * before it may enter the shared race. Ordinary bad driving passes; the checks only reject cars
 * that would spoil the race for everyone else: parked or crawling cars that become obstacles, and
 * cars that keep crashing into traffic.
 */
export const VALIDATION_RULES = {
  simulatedSeconds: 30,
  /** Seconds after the start that do not count toward the blocking check while the car settles in. */
  warmupSeconds: 4,
  /**
   * Traffic is kept this close around the one test car (race default: 250 m behind, 820 m ahead).
   * New cars still appear beyond sensor range, and there are about 40% as many cars to simulate,
   * which cuts the test drive's CPU time from about 3 s to about 1 s.
   */
  trafficWindow: { behind: 120, ahead: 320 },
  /**
   * Denser than the default race traffic (0.45) so a car that ignores the road ahead is sure to meet
   * cars. 0.58 in the smaller window matches the traffic within sensor range of density 0.55 in the
   * race-sized window, which the thresholds below were calibrated against.
   */
  trafficDensity: 0.58,
  /**
   * A car counts as blocking while it is slower than this (m/s, about 54 km/h; traffic wants
   * 18–40 m/s), is not speeding up, and is not held back by the car ahead. Slowing behind slower
   * traffic never counts.
   */
  blockingSpeed: 15,
  /** The car ahead holds you back only if it is within this many meters... */
  clearRoadMeters: 60,
  /**
   * ...and not pulling away faster than this (m/s). Traffic that passes a slow car often merges
   * back just in front of it, so closeness alone would excuse a crawler.
   */
  leadPullingAwaySpeed: 3,
  /**
   * Only steady driving counts: a car gaining speed faster than this (m/s²) is pulling away, and one
   * braking harder than `blockingMinAcceleration` is reacting to something, such as a cut-in.
   */
  blockingMaxAcceleration: 1,
  blockingMinAcceleration: -1.5,
  /** Cars this far (m) beyond touching the test car sideways still count as ahead of it: cut-ins and drifters. */
  leadLateralMargin: 0.6,
  /** Largest share of post-warmup time the car may spend blocking. */
  maxBlockingFraction: 0.2,
  /** At-fault collisions allowed during the run. */
  maxAtFaultCollisions: 3,
  /** A driver that errors or times out this many steps in a row (about 1 s) is stopped early. */
  maxConsecutiveFailures: 45,
} as const;

/** Runs one autopilot step. Throwing counts as a failed step; the car coasts, as in a race. */
export type DriveStep = (input: AutopilotInput) => unknown | Promise<unknown>;

export interface ValidationOptions {
  seed: number;
  simulatedSeconds?: number;
  /** Epoch milliseconds after which the run stops and the driver is rejected as too slow. */
  deadline?: number;
}

const CANDIDATE_ID = 'candidate';

export async function runValidation(drive: DriveStep, options: ValidationOptions): Promise<ValidationReport> {
  const rules = VALIDATION_RULES;
  const totalSeconds = options.simulatedSeconds ?? rules.simulatedSeconds;
  const settings = { ...raceSettings(0, rules.trafficDensity), seed: options.seed };
  const simulation = new Simulation(settings, {
    players: [{ id: CANDIDATE_ID, color: '#ffffff' }],
    atFaultStallSeconds: RACE_SCORING.atFaultStallSeconds,
    trafficWindow: rules.trafficWindow,
  });

  let failedSteps = 0;
  let consecutiveFailures = 0;
  let firstError: string | undefined;
  let measuredSeconds = 0;
  let blockingSeconds = 0;
  let distanceAtWarmup = 0;
  // Speeds over the last half second, to tell a car pulling away from one that is slow by choice.
  const accelerationWindow = Math.round(0.5 / FIXED_TIMESTEP);
  const recentSpeeds: number[] = [];

  while (simulation.currentTime < totalSeconds - 1e-9) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      return {
        passed: false,
        issues: [{ check: 'timeout', message: 'The test drive took too long. Your driver may be too slow to run every step in time.' }],
        firstError,
      };
    }

    const input = simulation.createPlayerInput(CANDIDATE_ID, settings, FIXED_TIMESTEP);
    let output: unknown;
    try {
      output = await drive(input);
      consecutiveFailures = 0;
    } catch (error) {
      failedSteps += 1;
      consecutiveFailures += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
      if (consecutiveFailures >= rules.maxConsecutiveFailures) {
        return {
          passed: false,
          issues: [
            {
              check: 'errors',
              message: `Your driver failed ${rules.maxConsecutiveFailures} steps in a row, so the car would coast and block traffic. First error: ${firstError}`,
            },
          ],
          firstError,
        };
      }
    }
    simulation.stepPlayers(FIXED_TIMESTEP, new Map([[CANDIDATE_ID, output]]), settings);

    const [state] = simulation.getPlayerStates();
    recentSpeeds.push(state.speed);
    if (recentSpeeds.length > accelerationWindow + 1) recentSpeeds.shift();
    const acceleration = (state.speed - recentSpeeds[0]) / (FIXED_TIMESTEP * Math.max(1, recentSpeeds.length - 1));
    if (simulation.currentTime <= rules.warmupSeconds) {
      distanceAtWarmup = state.distance;
      continue;
    }
    measuredSeconds += FIXED_TIMESTEP;
    if (
      state.speed < rules.blockingSpeed &&
      acceleration < rules.blockingMaxAcceleration &&
      acceleration > rules.blockingMinAcceleration &&
      !heldBackByLead(simulation.playerLeadAhead(CANDIDATE_ID, rules.leadLateralMargin), state.speed)
    ) {
      blockingSeconds += FIXED_TIMESTEP;
    }
  }

  const [state] = simulation.getPlayerStates();
  const metrics: ValidationMetrics = {
    simulatedSeconds: simulation.currentTime,
    distance: state.distance,
    averageSpeed: measuredSeconds > 0 ? (state.distance - distanceAtWarmup) / measuredSeconds : 0,
    blockingFraction: measuredSeconds > 0 ? blockingSeconds / measuredSeconds : 1,
    collisions: state.collisions,
    atFaultCollisions: state.atFaultCollisions,
    failedSteps,
  };
  const issues = judgeValidation(metrics);
  return { passed: issues.length === 0, issues, metrics, firstError };
}

function heldBackByLead(lead: { gap: number; speed: number } | undefined, speed: number): boolean {
  const rules = VALIDATION_RULES;
  return lead !== undefined && lead.gap <= rules.clearRoadMeters && lead.speed <= speed + rules.leadPullingAwaySpeed;
}

export function judgeValidation(metrics: ValidationMetrics): ValidationIssue[] {
  const rules = VALIDATION_RULES;
  const issues: ValidationIssue[] = [];
  if (metrics.blockingFraction > rules.maxBlockingFraction) {
    issues.push({
      check: 'blocking',
      message: `${metrics.averageSpeed < 3 ? 'The car mostly stood still' : 'The car drove too slowly'} with nothing holding it back: under ${kmh(rules.blockingSpeed)}, with no slower car close ahead, for ${percent(metrics.blockingFraction)} of the run (limit ${percent(rules.maxBlockingFraction)}). Slow cars become obstacles for everyone else.`,
    });
  }
  if (metrics.atFaultCollisions > rules.maxAtFaultCollisions) {
    issues.push({
      check: 'collisions',
      message: `The car caused ${metrics.atFaultCollisions} crashes in ${Math.round(metrics.simulatedSeconds)} s (up to ${rules.maxAtFaultCollisions} are allowed). Brake when the car ahead gets close, or use "Catch up to presenter" for a car that already does.`,
    });
  }
  return issues;
}

export function kmh(metersPerSecond: number): string {
  return `${Math.round(metersPerSecond * 3.6)} km/h`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
