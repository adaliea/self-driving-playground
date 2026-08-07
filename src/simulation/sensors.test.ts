import { describe, expect, it } from 'vitest';
import { normalizeAngle } from './math';
import { SeededRandom } from './random';
import { Road } from './road';
import { SensorSimulator } from './sensors';
import type { VehicleState } from './vehicle';

describe('vehicle pose sensing', () => {
  it('reports an oriented box in ego-relative coordinates without noise', () => {
    const road = new Road(12);
    const ego = vehicle('ego', 'ego', 120, road.getLaneCenterOffset(1), 0.08, 24);
    const target = vehicle('traffic-1', 'traffic', 164, road.getLaneCenterOffset(2), -0.05, 21);
    const input = new SensorSimulator().createInput(
      ego,
      [ego, target],
      road,
      { noisyLaneLines: false, noisyVehicles: false },
      new SeededRandom(99),
      1 / 45,
    );

    const detection = input.vehicles[0];
    const egoHeading = road.worldPointAt(ego.s, ego.lateral).heading + ego.headingOffset;
    const targetHeading = road.worldPointAt(target.s, target.lateral).heading + target.headingOffset;

    expect(detection.relativeHeading).toBeCloseTo(normalizeAngle(targetHeading - egoHeading), 10);
    expect(detection.width).toBe(target.width);
    expect(detection.length).toBe(target.length);
    expect(detection.confidence).toBe(1);
  });

  it('makes position, dimensions, velocity, and yaw noise deterministic for a seed', () => {
    const sample = () => {
      const road = new Road(22);
      const ego = vehicle('ego', 'ego', 120, 0, 0, 25);
      const target = vehicle('traffic-1', 'traffic', 176, 3.7, 0.11, 19);
      return new SensorSimulator().createInput(
        ego,
        [ego, target],
        road,
        { noisyLaneLines: false, noisyVehicles: true },
        new SeededRandom(31415),
        1 / 45,
      ).vehicles[0];
    };

    const first = sample();
    const second = sample();
    expect(first).toEqual(second);
    expect(first.relativeHeading).not.toBeCloseTo(0.11, 6);
    expect(first.confidence).toBeGreaterThanOrEqual(0.25);
    expect(first.confidence).toBeLessThanOrEqual(0.99);
  });
});

function vehicle(
  id: string,
  kind: VehicleState['kind'],
  s: number,
  lateral: number,
  headingOffset: number,
  speed: number,
): VehicleState {
  return {
    id,
    kind,
    s,
    lateral,
    headingOffset,
    speed,
    laneIndex: 1,
    targetLane: 1,
    desiredSpeed: speed,
    width: 2,
    length: 4.6,
    color: '#fff',
    actualMotor: 0,
    actualSteering: 0,
    commandMotor: 0,
    commandSteering: 0,
    laneChangeCooldown: 0,
    collision: false,
  };
}
