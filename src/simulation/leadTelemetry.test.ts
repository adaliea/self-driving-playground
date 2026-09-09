import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { DEFAULT_SETTINGS } from './defaults';
import { metersPerSecondToMph } from './math';
import type { VehicleTrack } from '../types';

const track = (id: string, laneIndex: number, relativeY: number): VehicleTrack => ({
  id, laneIndex, relativeY, relativeX: 0.2, relativeVy: -3, relativeVx: 0.1,
} as VehicleTrack);

describe('lead vehicle telemetry', () => {
  it('reports the nearest same-lane tracked vehicle using the controller sensor frame', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const input = simulation.createEgoInput(DEFAULT_SETTINGS, 1 / 45);
    input.ego.speed = 20;
    const lane = input.ego.laneIndex;
    input.vehicles = [track('other-lane', lane + 1, 2), track('behind', lane, -4), track('far', lane, 40), track('lead', lane, 10)];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle).toEqual({
      id: 'lead', speedMph: metersPerSecondToMph(17), relativeX: 0.2,
      relativeY: 10, relativeVx: 0.1, relativeVy: -3,
    });
    input.vehicles = [];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle).toBeUndefined();
  });
});
