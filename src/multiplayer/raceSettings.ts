import { DEFAULT_SETTINGS } from '../simulation/defaults';
import type { PlaygroundSettings } from '../types';

export function raceSettings(round: number, trafficDensity: number): PlaygroundSettings {
  return {
    ...DEFAULT_SETTINGS,
    seed: 1000 + round * 37,
    trafficDensity,
    startingSpeed: 20,
    noisyLaneLines: true,
    noisyVehicles: true,
    actuatorVariation: true,
    wind: true,
    debugOverlays: false,
    steerAssist: false,
    accelerateAssist: false,
  };
}
