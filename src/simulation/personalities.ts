import { clamp } from './math';
import type { SeededRandom } from './random';

export type TrafficPersonalityId = 'cautious' | 'commuter' | 'assertive' | 'tailgater' | 'truck' | 'distracted';

export interface TrafficPersonality {
  id: TrafficPersonalityId;
  label: string;
  desiredSpeedMin: number;
  desiredSpeedMax: number;
  timeHeadway: number;
  minGap: number;
  laneChangeLookahead: number;
  laneChangeEagerness: number;
  laneChangeCooldown: number;
  laneChangeMaxLateralVelocity: number;
  laneChangeFrontGap: number;
  laneChangeRearGap: number;
  laneChangeTimeBuffer: number;
  overtakeSpeedDelta: number;
  speedGain: number;
  gapGain: number;
  brakeGain: number;
  feedforwardWeight: number;
  headingGain: number;
  /**
   * Peak meters the driver wanders from its lane center while holding a lane.
   * Capped per vehicle so the body stays inside the lane, which also keeps it off the road edge.
   */
  weaveAmplitude: number;
  /** Seconds for one slow side-to-side wander. */
  weavePeriod: number;
  /** Share of these drivers who wander wide enough to drift over the lane line into an open adjacent lane. */
  laneDriftShare: number;
  color: string;
}

export interface TrafficPersonalityInstance extends TrafficPersonality {
  variation: number;
  /** Random phase so weaving cars don't move in step, in radians. */
  weavePhase: number;
  /** Drifts partway into an adjacent lane when it is clear. Never toward the road edge. */
  laneDrifter: boolean;
}

const PERSONALITIES: TrafficPersonality[] = [
  {
    id: 'cautious',
    label: 'Cautious',
    desiredSpeedMin: 18,
    desiredSpeedMax: 29,
    timeHeadway: 1.8,
    minGap: 12,
    laneChangeLookahead: 34,
    laneChangeEagerness: 0.25,
    laneChangeCooldown: 8.5,
    laneChangeMaxLateralVelocity: 0.95,
    laneChangeFrontGap: 18,
    laneChangeRearGap: 20,
    laneChangeTimeBuffer: 0.68,
    overtakeSpeedDelta: 2.3,
    speedGain: 0.06,
    gapGain: 0.22,
    brakeGain: 0.075,
    feedforwardWeight: 0.75,
    headingGain: 0.82,
    weaveAmplitude: 0.06,
    weavePeriod: 9,
    laneDriftShare: 0,
    color: '#d7dde3',
  },
  {
    id: 'commuter',
    label: 'Commuter',
    desiredSpeedMin: 22,
    desiredSpeedMax: 34,
    timeHeadway: 1.35,
    minGap: 9,
    laneChangeLookahead: 42,
    laneChangeEagerness: 0.52,
    laneChangeCooldown: 5.8,
    laneChangeMaxLateralVelocity: 1.25,
    laneChangeFrontGap: 14,
    laneChangeRearGap: 15,
    laneChangeTimeBuffer: 0.48,
    overtakeSpeedDelta: 1.4,
    speedGain: 0.08,
    gapGain: 0.34,
    brakeGain: 0.095,
    feedforwardWeight: 0.9,
    headingGain: 0.88,
    weaveAmplitude: 0.1,
    weavePeriod: 8,
    laneDriftShare: 0,
    color: '#a9bed0',
  },
  {
    id: 'assertive',
    label: 'Assertive',
    desiredSpeedMin: 27,
    desiredSpeedMax: 40,
    timeHeadway: 1.0,
    minGap: 7,
    laneChangeLookahead: 55,
    laneChangeEagerness: 0.82,
    laneChangeCooldown: 3.6,
    laneChangeMaxLateralVelocity: 1.65,
    laneChangeFrontGap: 9.5,
    laneChangeRearGap: 10.5,
    laneChangeTimeBuffer: 0.28,
    overtakeSpeedDelta: 0.8,
    speedGain: 0.105,
    gapGain: 0.42,
    brakeGain: 0.11,
    feedforwardWeight: 1,
    headingGain: 0.98,
    weaveAmplitude: 0.14,
    weavePeriod: 6.5,
    laneDriftShare: 0,
    color: '#8ea6ff',
  },
  {
    id: 'tailgater',
    label: 'Tailgater',
    desiredSpeedMin: 25,
    desiredSpeedMax: 38,
    timeHeadway: 0.88,
    minGap: 7.1,
    laneChangeLookahead: 48,
    laneChangeEagerness: 0.58,
    laneChangeCooldown: 5.4,
    laneChangeMaxLateralVelocity: 1.55,
    laneChangeFrontGap: 10.5,
    laneChangeRearGap: 11.5,
    laneChangeTimeBuffer: 0.34,
    overtakeSpeedDelta: 1,
    speedGain: 0.12,
    gapGain: 0.42,
    brakeGain: 0.13,
    feedforwardWeight: 1,
    headingGain: 1,
    weaveAmplitude: 0.16,
    weavePeriod: 6,
    laneDriftShare: 0,
    color: '#f0b56a',
  },
  {
    id: 'truck',
    label: 'Truck',
    desiredSpeedMin: 16,
    desiredSpeedMax: 26,
    timeHeadway: 1.65,
    minGap: 13.5,
    laneChangeLookahead: 30,
    laneChangeEagerness: 0.18,
    laneChangeCooldown: 10,
    laneChangeMaxLateralVelocity: 0.82,
    laneChangeFrontGap: 20,
    laneChangeRearGap: 23,
    laneChangeTimeBuffer: 0.78,
    overtakeSpeedDelta: 2.8,
    speedGain: 0.052,
    gapGain: 0.2,
    brakeGain: 0.08,
    feedforwardWeight: 0.68,
    headingGain: 0.72,
    weaveAmplitude: 0.08,
    weavePeriod: 11,
    laneDriftShare: 0,
    color: '#82dec1',
  },
  {
    id: 'distracted',
    label: 'Distracted',
    desiredSpeedMin: 17,
    desiredSpeedMax: 33,
    timeHeadway: 1.15,
    minGap: 8,
    laneChangeLookahead: 36,
    laneChangeEagerness: 0.34,
    laneChangeCooldown: 7.2,
    laneChangeMaxLateralVelocity: 1.05,
    laneChangeFrontGap: 15,
    laneChangeRearGap: 17,
    laneChangeTimeBuffer: 0.58,
    overtakeSpeedDelta: 1.8,
    speedGain: 0.055,
    gapGain: 0.26,
    brakeGain: 0.07,
    feedforwardWeight: 0.78,
    headingGain: 0.78,
    weaveAmplitude: 0.42,
    weavePeriod: 5.5,
    laneDriftShare: 0.4,
    color: '#c9b4ff',
  },
];

export const DEFAULT_TRAFFIC_PERSONALITY = PERSONALITIES[1];

export function createTrafficPersonality(rng: SeededRandom, density: number): TrafficPersonalityInstance {
  const profile = choosePersonality(rng, density);
  const variation = rng.range(-1, 1);
  const speedScale = 1 + variation * 0.07;
  const gapScale = 1 + variation * -0.08;
  const responseScale = 1 + variation * 0.08;
  const steeringScale = 1 + variation * 0.05;

  return {
    ...profile,
    desiredSpeedMin: clamp(profile.desiredSpeedMin * speedScale + rng.range(-1.2, 1.2), 8, 46),
    desiredSpeedMax: clamp(profile.desiredSpeedMax * speedScale + rng.range(-1.4, 1.4), 10, 48),
    timeHeadway: clamp(profile.timeHeadway * gapScale + rng.range(-0.08, 0.08), 0.55, 2.2),
    minGap: clamp(profile.minGap * gapScale + rng.range(-0.7, 0.7), 4.5, 16),
    laneChangeLookahead: clamp(profile.laneChangeLookahead + rng.range(-5, 5), 24, 62),
    laneChangeEagerness: clamp(profile.laneChangeEagerness + rng.range(-0.08, 0.08), 0.05, 0.95),
    laneChangeCooldown: clamp(profile.laneChangeCooldown + rng.range(-0.8, 0.8), 2.8, 11),
    laneChangeMaxLateralVelocity: clamp(profile.laneChangeMaxLateralVelocity * (1 + variation * 0.08), 0.7, 1.85),
    laneChangeFrontGap: clamp(profile.laneChangeFrontGap * gapScale + rng.range(-1.2, 1.2), 7, 24),
    laneChangeRearGap: clamp(profile.laneChangeRearGap * gapScale + rng.range(-1.5, 1.5), 8, 28),
    laneChangeTimeBuffer: clamp(profile.laneChangeTimeBuffer + rng.range(-0.06, 0.06), 0.2, 0.9),
    speedGain: clamp(profile.speedGain * responseScale, 0.035, 0.14),
    gapGain: clamp(profile.gapGain * responseScale, 0.16, 0.58),
    brakeGain: clamp(profile.brakeGain * responseScale, 0.045, 0.16),
    headingGain: clamp(profile.headingGain * steeringScale, 0.58, 1.1),
    weaveAmplitude: Math.max(0, profile.weaveAmplitude * (1 + variation * 0.25)),
    weavePeriod: profile.weavePeriod * rng.range(0.85, 1.15),
    weavePhase: rng.range(0, Math.PI * 2),
    laneDrifter: rng.chance(profile.laneDriftShare),
    variation,
  };
}

export function getTrafficPersonalities(): TrafficPersonality[] {
  return PERSONALITIES;
}

function choosePersonality(rng: SeededRandom, density: number): TrafficPersonality {
  const dense = clamp(density, 0, 1);
  const weights: Record<TrafficPersonalityId, number> = {
    cautious: 0.2 + dense * 0.12,
    commuter: 0.38 - dense * 0.04,
    assertive: 0.18 - dense * 0.05,
    tailgater: 0.1 + dense * 0.1,
    truck: 0.08 + dense * 0.04,
    distracted: 0.06 + dense * 0.06,
  };

  const total = PERSONALITIES.reduce((sum, profile) => sum + weights[profile.id], 0);
  let cursor = rng.range(0, total);
  for (const profile of PERSONALITIES) {
    cursor -= weights[profile.id];
    if (cursor <= 0) return profile;
  }

  return DEFAULT_TRAFFIC_PERSONALITY;
}
