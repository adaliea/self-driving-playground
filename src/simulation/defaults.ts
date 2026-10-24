import type { PlaygroundSettings } from '../types';

export const DEFAULT_SETTINGS: PlaygroundSettings = {
  seed: 42,
  trafficDensity: 0.55,
  startingSpeed: 24,
  noisyLaneLines: true,
  noisyVehicles: true,
  actuatorVariation: true,
  wind: true,
  debugOverlays: true,
  steerAssist: false,
  accelerateAssist: false,
};

export const FIXED_TIMESTEP = 1 / 45;
