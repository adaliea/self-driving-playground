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
  overtakeSpeedDelta: number;
  speedGain: number;
  gapGain: number;
  brakeGain: number;
  feedforwardWeight: number;
  steeringGain: number;
  headingGain: number;
  color: string;
}

export interface TrafficPersonalityInstance extends TrafficPersonality {
  variation: number;
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
    overtakeSpeedDelta: 2.3,
    speedGain: 0.06,
    gapGain: 0.22,
    brakeGain: 0.075,
    feedforwardWeight: 0.75,
    steeringGain: 0.24,
    headingGain: 0.82,
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
    overtakeSpeedDelta: 1.4,
    speedGain: 0.08,
    gapGain: 0.34,
    brakeGain: 0.095,
    feedforwardWeight: 0.9,
    steeringGain: 0.28,
    headingGain: 0.88,
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
    overtakeSpeedDelta: 0.8,
    speedGain: 0.105,
    gapGain: 0.42,
    brakeGain: 0.11,
    feedforwardWeight: 1,
    steeringGain: 0.32,
    headingGain: 0.98,
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
    overtakeSpeedDelta: 1,
    speedGain: 0.12,
    gapGain: 0.42,
    brakeGain: 0.13,
    feedforwardWeight: 1,
    steeringGain: 0.26,
    headingGain: 1,
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
    overtakeSpeedDelta: 2.8,
    speedGain: 0.052,
    gapGain: 0.2,
    brakeGain: 0.08,
    feedforwardWeight: 0.68,
    steeringGain: 0.2,
    headingGain: 0.72,
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
    overtakeSpeedDelta: 1.8,
    speedGain: 0.055,
    gapGain: 0.26,
    brakeGain: 0.07,
    feedforwardWeight: 0.78,
    steeringGain: 0.22,
    headingGain: 0.78,
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
    speedGain: clamp(profile.speedGain * responseScale, 0.035, 0.14),
    gapGain: clamp(profile.gapGain * responseScale, 0.16, 0.58),
    brakeGain: clamp(profile.brakeGain * responseScale, 0.045, 0.16),
    steeringGain: clamp(profile.steeringGain * steeringScale, 0.16, 0.34),
    headingGain: clamp(profile.headingGain * steeringScale, 0.58, 1.1),
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
