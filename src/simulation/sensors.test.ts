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
    const measurement = input.vehicleMeasurements[0];
    const egoHeading = road.worldPointAt(ego.s, ego.lateral).heading + ego.headingOffset;
    const targetHeading = road.worldPointAt(target.s, target.lateral).heading + target.headingOffset;

    expect(detection.relativeHeading).toBeCloseTo(normalizeAngle(targetHeading - egoHeading), 10);
    expect(detection.width).toBe(target.width);
    expect(detection.length).toBe(target.length);
    expect(detection.confidence).toBe(1);
    expect(measurement.relativeX).toBe(detection.relativeX);
    expect(measurement.relativeY).toBe(detection.relativeY);
    expect(measurement.uncertainty.longitudinalPosition).toBe(0);
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
      );
    };

    const first = sample();
    const second = sample();
    expect(first).toEqual(second);
    expect(first.vehicles[0].relativeHeading).not.toBeCloseTo(0.11, 6);
    expect(first.vehicleMeasurements[0].uncertainty.longitudinalPosition).toBeGreaterThan(
      first.vehicleMeasurements[0].uncertainty.lateralPosition,
    );
    expect(first.vehicles[0].confidence).toBeGreaterThanOrEqual(0.25);
    expect(first.vehicles[0].confidence).toBeLessThanOrEqual(0.99);
  });

  it('expires an old identity and seeds a re-entering vehicle from its new measurement', () => {
    const road = new Road(18);
    const ego = vehicle('ego', 'ego', 120, road.getLaneCenterOffset(1), 0, 24);
    const target = vehicle('traffic-1', 'traffic', 160, road.getLaneCenterOffset(1), 0, 20);
    const sensors = new SensorSimulator();
    const rng = new NoDropoutRandom(2026);
    const options = { noisyLaneLines: false, noisyVehicles: true };
    const dt = 1 / 45;

    expect(sensors.createInput(ego, [ego, target], road, options, rng, dt).vehicles).toHaveLength(1);

    target.s = ego.s + 500;
    let outOfView = sensors.createInput(ego, [ego, target], road, options, rng, dt);
    for (let frame = 0; frame < 24; frame += 1) {
      outOfView = sensors.createInput(ego, [ego, target], road, options, rng, dt);
    }
    expect(outOfView.vehicles).toHaveLength(0);

    target.s = ego.s + 34;
    target.lateral = road.getLaneCenterOffset(0);
    const reentered = sensors.createInput(ego, [ego, target], road, options, rng, dt);
    expect(reentered.vehicleMeasurements).toHaveLength(1);
    expect(reentered.vehicles).toHaveLength(1);
    expect(reentered.vehicles[0].relativeX).toBe(reentered.vehicleMeasurements[0].relativeX);
    expect(reentered.vehicles[0].relativeY).toBe(reentered.vehicleMeasurements[0].relativeY);
    expect(reentered.vehicles[0].age).toBeCloseTo(dt, 8);
  });

  it('keeps most raw measurement noise independent from frame to frame', () => {
    const road = new Road(31);
    const ego = vehicle('ego', 'ego', 120, road.getLaneCenterOffset(1), 0, 24);
    const target = vehicle('traffic-1', 'traffic', 180, road.getLaneCenterOffset(1), 0, 20);
    const sensors = new SensorSimulator();
    const rng = new NoDropoutRandom(8080);
    const residuals: number[] = [];
    const truthY = sensors.createInput(
      ego,
      [ego, target],
      road,
      { noisyLaneLines: false, noisyVehicles: false },
      new SeededRandom(1),
      1 / 45,
    ).vehicleMeasurements[0].relativeY;

    for (let frame = 0; frame < 500; frame += 1) {
      const input = sensors.createInput(
        ego,
        [ego, target],
        road,
        { noisyLaneLines: false, noisyVehicles: true },
        rng,
        1 / 45,
      );
      residuals.push(input.vehicleMeasurements[0].relativeY - truthY);
    }

    expect(Math.abs(lagOneCorrelation(residuals))).toBeLessThan(0.18);
  });
});

class NoDropoutRandom extends SeededRandom {
  override chance(): boolean {
    return false;
  }
}

function lagOneCorrelation(values: number[]): number {
  const first = values.slice(0, -1);
  const second = values.slice(1);
  const firstMean = first.reduce((sum, value) => sum + value, 0) / first.length;
  const secondMean = second.reduce((sum, value) => sum + value, 0) / second.length;
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < first.length; index += 1) {
    const firstDelta = first[index] - firstMean;
    const secondDelta = second[index] - secondMean;
    covariance += firstDelta * secondDelta;
    firstVariance += firstDelta ** 2;
    secondVariance += secondDelta ** 2;
  }
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

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
