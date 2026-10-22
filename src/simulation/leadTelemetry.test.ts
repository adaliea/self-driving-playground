import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { DEFAULT_SETTINGS } from './defaults';
import { metersPerSecondToMph } from './math';
import type { VehicleTrack } from '../types';

const track = (id: string, relativeX: number, relativeY: number): VehicleTrack => ({
  id, relativeX, relativeY, relativeVy: -3, relativeVx: 0.1, relativeHeading: 0, width: 1.9, length: 4.6,
} as VehicleTrack);

describe('lead vehicle telemetry', () => {
  it('reports the nearest same-lane tracked vehicle using the controller sensor frame', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const input = simulation.createEgoInput(DEFAULT_SETTINGS, 1 / 45);
    input.ego.speed = 20;
    input.vehicles = [track('other-lane', 3.9, 2), track('behind', 0.2, -4), track('far', 0.2, 40), track('lead', 0.2, 10)];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle).toEqual({
      id: 'lead', speedMph: metersPerSecondToMph(17), relativeX: 0.2,
      relativeY: 10, relativeVx: 0.1, relativeVy: -3,
    });
    input.vehicles = [];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle).toBeUndefined();
  });

  it('treats a vehicle as in our lane when any part of its bounding box crosses our lane line', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const input = simulation.createEgoInput(DEFAULT_SETTINGS, 1 / 45);
    const rightLine = input.laneLines.right[0].x;
    // Center is in the next lane, but the left edge pokes 0.15 m over our right line.
    input.vehicles = [track('straddling', rightLine + 0.95 - 0.15, 10)];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle?.id).toBe('straddling');
    input.vehicles = [track('adjacent', rightLine + 0.95 + 0.15, 10)];
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.leadVehicle).toBeUndefined();
  });
});
