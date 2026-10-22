import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './defaults';
import { ROAD_LANE_WIDTH } from './road';
import { Simulation } from './simulation';
import type { VehicleState } from './vehicle';

interface SimulationInternals {
  vehicles: VehicleState[];
  time: number;
  trafficWeaveOffset(vehicle: VehicleState, dt: number): number;
}

const DT = 1 / 45;

function setup(lane: number, laneDrifter: boolean) {
  const simulation = new Simulation({ ...DEFAULT_SETTINGS, trafficDensity: 0 });
  const internals = simulation as unknown as SimulationInternals;
  const traffic = internals.vehicles.find((vehicle) => vehicle.kind === 'traffic')!;
  const car: VehicleState = {
    ...traffic,
    s: 5000,
    lateral: (lane - 1) * ROAD_LANE_WIDTH,
    laneIndex: lane,
    targetLane: lane,
    width: 2,
    personality: { ...traffic.personality!, weaveAmplitude: 0.42, weavePeriod: 5.5, weavePhase: 0, laneDrifter },
  };
  internals.vehicles = [car];
  const laneRoom = ROAD_LANE_WIDTH / 2 - car.width / 2;
  return { internals, car, laneRoom };
}

/** Offsets over 40 s of wandering, after weaving has fully faded in. */
function offsets(internals: SimulationInternals, car: VehicleState): number[] {
  const result: number[] = [];
  for (let step = 0; step < 50 * 45; step += 1) {
    internals.time += DT;
    const offset = internals.trafficWeaveOffset(car, DT);
    if (internals.time > 10) result.push(offset);
  }
  return result;
}

describe('traffic weaving', () => {
  it('keeps ordinary weavers inside their lane', () => {
    const { internals, car, laneRoom } = setup(1, false);
    const all = offsets(internals, car);
    expect(Math.max(...all.map(Math.abs))).toBeLessThanOrEqual(laneRoom - 0.2 + 1e-9);
    expect(Math.max(...all)).toBeGreaterThan(0.2);
  });

  it('lets drifters cross into a clear adjacent lane, but only partway', () => {
    const { internals, car, laneRoom } = setup(1, true);
    const all = offsets(internals, car);
    expect(Math.max(...all)).toBeGreaterThan(laneRoom);
    expect(Math.min(...all)).toBeLessThan(-laneRoom);
    expect(Math.max(...all.map(Math.abs))).toBeLessThanOrEqual(laneRoom + 0.5 + 1e-9);
  });

  it('never lets drifters wander toward the road edge', () => {
    const { internals, car, laneRoom } = setup(0, true);
    const all = offsets(internals, car);
    // Lane 0 is the leftmost lane, so negative offsets point at the road edge.
    expect(Math.min(...all)).toBeGreaterThanOrEqual(-(laneRoom - 0.5) - 1e-9);
    expect(Math.max(...all)).toBeGreaterThan(laneRoom);
  });

  it('keeps drifters out of an adjacent lane that has a car alongside', () => {
    const { internals, car, laneRoom } = setup(1, true);
    const neighbor: VehicleState = { ...car, id: 'neighbor', lateral: ROAD_LANE_WIDTH, laneIndex: 2, targetLane: 2 };
    internals.vehicles.push(neighbor);
    const all = offsets(internals, car);
    expect(Math.max(...all)).toBeLessThanOrEqual(laneRoom - 0.2 + 1e-9);
    expect(Math.min(...all)).toBeLessThan(-laneRoom);
  });

  it('stops weaving while changing lanes', () => {
    const { internals, car } = setup(1, true);
    offsets(internals, car);
    car.targetLane = 2;
    for (let step = 0; step < 45; step += 1) internals.trafficWeaveOffset(car, DT);
    expect(internals.trafficWeaveOffset(car, DT)).toBe(0);
  });
});
