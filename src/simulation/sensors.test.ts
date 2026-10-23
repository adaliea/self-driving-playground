import { describe, expect, it } from 'vitest';
import { normalizeAngle } from './math';
import { SeededRandom } from './random';
import { Road } from './road';
import { SensorSimulator } from './sensors';
import { VehicleTracker } from './vehicleTracker';
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

describe('ego yaw rate and ego-motion-compensated tracking', () => {
  it('reports world yaw rate, including road curvature, as the per-tick world heading change', () => {
    const road = new Road(5);
    const s = sharpestCurveStation(road);
    const ego = vehicle('ego', 'ego', s, 0, 0.02, 25);
    const sensors = new SensorSimulator();
    const settings = { noisyLaneLines: false, noisyVehicles: false };
    const dt = 1 / 45;
    const first = sensors.createInput(ego, [ego], road, settings, new SeededRandom(1), dt);
    const headingBefore = road.worldPointAt(ego.s, ego.lateral).heading + ego.headingOffset;
    ego.s += ego.speed * dt;
    ego.headingOffset = 0.03;
    const second = sensors.createInput(ego, [ego], road, settings, new SeededRandom(1), dt);
    const headingAfter = road.worldPointAt(ego.s, ego.lateral).heading + ego.headingOffset;

    expect(first.ego.yawRate).toBe(0);
    expect(second.ego.yawRate * dt).toBeCloseTo(normalizeAngle(headingAfter - headingBefore), 12);
    // The road-relative heading moved 0.01 rad; the rest of the yaw is the road curving.
    expect(Math.abs(second.ego.yawRate * dt - 0.01)).toBeGreaterThan(0.002);
    expect(second.ego.heading - first.ego.heading).toBeCloseTo(0.01, 12);
  });

  it('keeps built-in tracks on target through a curve with a lane change', () => {
    const road = new Road(5);
    const dt = 1 / 45;
    const startS = sharpestCurveStation(road) - 120;
    const laneWidth = road.getLaneCenterOffset(1) - road.getLaneCenterOffset(0);
    const egoLane = road.getLaneCenterOffset(1);
    const ego = vehicle('ego', 'ego', startS, egoLane, 0, 24);
    const targets = [
      vehicle('lead', 'traffic', startS + 35, egoLane, 0, 21),
      vehicle('left', 'traffic', startS + 12, road.getLaneCenterOffset(0), 0, 27),
      vehicle('right', 'traffic', startS + 55, road.getLaneCenterOffset(2), 0, 19),
    ];
    const all = [ego, ...targets];
    const sensors = new SensorSimulator();
    const truthSensors = new SensorSimulator();
    const legacy = new VehicleTracker();
    const rng = new NoDropoutRandom(77);
    const errors = { compensated: 0, legacy: 0, compensatedVelocity: 0, legacyVelocity: 0, count: 0 };

    for (let t = 0; t < 10; t += dt) {
      // Lane change to the right between 3 s and 6 s (smooth cosine lateral profile).
      const phase = Math.min(1, Math.max(0, (t - 3) / 3));
      const lateralRate = phase > 0 && phase < 1 ? (laneWidth * Math.PI * Math.sin(Math.PI * phase)) / 6 : 0;
      ego.lateral = egoLane + (laneWidth * (1 - Math.cos(Math.PI * phase))) / 2;
      ego.headingOffset = Math.atan2(lateralRate, ego.speed);
      ego.s += ego.speed * dt;
      for (const target of targets) target.s += target.speed * dt;

      const input = sensors.createInput(ego, all, road, { noisyLaneLines: false, noisyVehicles: true }, rng, dt);
      const legacyTracks = legacy.update(input.vehicleMeasurements, dt);
      const truth = truthSensors.createTrafficInput(ego, all, road, new SeededRandom(1), dt).vehicles;
      if (t < 1) continue;
      for (const expected of truth) {
        const compensated = input.vehicles.find((track) => track.id === expected.id);
        const old = legacyTracks.find((track) => track.id === expected.id);
        if (!compensated || !old) continue;
        errors.compensated += (compensated.relativeX - expected.relativeX) ** 2 + (compensated.relativeY - expected.relativeY) ** 2;
        errors.legacy += (old.relativeX - expected.relativeX) ** 2 + (old.relativeY - expected.relativeY) ** 2;
        errors.compensatedVelocity +=
          (compensated.relativeVx - expected.relativeVx) ** 2 + (compensated.relativeVy - expected.relativeVy) ** 2;
        errors.legacyVelocity += (old.relativeVx - expected.relativeVx) ** 2 + (old.relativeVy - expected.relativeVy) ** 2;
        errors.count += 1;
      }
    }

    const rms = (sum: number) => Math.sqrt(sum / errors.count);
    console.info(
      `sensor pipeline curve + lane change RMS: position legacy ${rms(errors.legacy).toFixed(3)} m -> ` +
        `compensated ${rms(errors.compensated).toFixed(3)} m; velocity legacy ${rms(errors.legacyVelocity).toFixed(3)} m/s -> ` +
        `compensated ${rms(errors.compensatedVelocity).toFixed(3)} m/s`,
    );
    expect(errors.count).toBeGreaterThan(1000);
    expect(rms(errors.compensated)).toBeLessThan(rms(errors.legacy) * 0.85);
    expect(rms(errors.compensatedVelocity)).toBeLessThan(rms(errors.legacyVelocity) * 0.5);
  });
});

/** Station of the tightest curve in the first few kilometers, so curvature effects are unmistakable. */
function sharpestCurveStation(road: Road): number {
  let best = 400;
  for (let s = 400; s < 3000; s += 5) {
    if (Math.abs(road.sampleAt(s).curvature) > Math.abs(road.sampleAt(best).curvature)) best = s;
  }
  return best;
}

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
