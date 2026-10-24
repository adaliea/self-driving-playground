import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { clampImplementation, vehicleTrackerImplementation } from '../toolbox/library';
import type { EgoState, VehicleMeasurement, VehicleTrack } from '../types';
import { normalizeAngle } from './math';
import { SeededRandom } from './random';
import { VehicleTracker } from './vehicleTracker';

/**
 * Ego-motion compensation: the trackers live in the ego frame, so an ego turn
 * rotates every track. These scenarios drive ego through a road curve and a
 * lane change in a small world-frame simulation (same projection as
 * sensors.ts), feed identical noisy measurements to a tracker with and without
 * ego motion, and compare against ground truth.
 */

const DT = 1 / 45;
const WARMUP = 1;

interface Pose {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

interface Target extends Pose {
  id: string;
  /** World yaw rate, so a target can follow the same curve as ego. */
  yawRate: number;
}

interface Scenario {
  duration: number;
  ego: Pose;
  egoYawRate: (t: number) => number;
  egoAccel?: (t: number) => number;
  /** Ego heading relative to the road (what input.ego.heading reports). */
  egoRoadHeading: (ego: Pose) => number;
  targets: Target[];
}

interface ErrorStats {
  position: number;
  velocity: number;
  heading: number;
}

type TrackerUpdate = (measurements: VehicleMeasurement[], dt: number, ego: EgoState) => VehicleTrack[];

function advance(pose: Pose, yawRate: number, accel: number): void {
  const headingDelta = yawRate * DT;
  const speed = pose.speed + accel * DT;
  const distance = 0.5 * (pose.speed + speed) * DT;
  // Constant-curvature arc: the chord points half way through the turn.
  const chord = Math.abs(headingDelta) > 1e-9 ? (distance * Math.sin(headingDelta / 2)) / (headingDelta / 2) : distance;
  const chordHeading = pose.heading + headingDelta / 2;
  pose.x += chord * Math.sin(chordHeading);
  pose.y += chord * Math.cos(chordHeading);
  pose.heading += headingDelta;
  pose.speed = speed;
}

function relativeTruth(ego: Pose, target: Target): VehicleTrack {
  const forward = { x: Math.sin(ego.heading), y: Math.cos(ego.heading) };
  const right = { x: Math.cos(ego.heading), y: -Math.sin(ego.heading) };
  const dx = target.x - ego.x;
  const dy = target.y - ego.y;
  const relativeHeading = normalizeAngle(target.heading - ego.heading);
  return {
    id: target.id,
    relativeX: dx * right.x + dy * right.y,
    relativeY: dx * forward.x + dy * forward.y,
    relativeVx: target.speed * Math.sin(relativeHeading),
    relativeVy: target.speed * Math.cos(relativeHeading) - ego.speed,
    relativeHeading,
    width: 2,
    length: 4.6,
    confidence: 1,
    age: 0,
    timeSinceMeasurement: 0,
    isPredicted: false,
    uncertainty: { lateralPosition: 0, longitudinalPosition: 0, lateralVelocity: 0, longitudinalVelocity: 0, heading: 0 },
  };
}

function runScenario(scenario: Scenario, updates: Record<string, TrackerUpdate>, seed = 7): Record<string, ErrorStats> {
  const rng = new SeededRandom(seed);
  const ego = { ...scenario.ego };
  const targets = scenario.targets.map((target) => ({ ...target }));
  const sums: Record<string, { position: number; velocity: number; heading: number; count: number }> = {};
  for (const name of Object.keys(updates)) sums[name] = { position: 0, velocity: 0, heading: 0, count: 0 };
  let previousHeading = ego.heading;

  for (let t = 0; t < scenario.duration; t += DT) {
    advance(ego, scenario.egoYawRate(t), scenario.egoAccel?.(t) ?? 0);
    for (const target of targets) advance(target, target.yawRate, 0);
    const egoInput: EgoState = { speed: ego.speed, heading: scenario.egoRoadHeading(ego), yawRate: (ego.heading - previousHeading) / DT, laneIndex: 1 };
    previousHeading = ego.heading;

    const truths = targets.map((target) => relativeTruth(ego, target));
    const measurements: VehicleMeasurement[] = truths.map((truth) => ({
      id: truth.id,
      relativeX: truth.relativeX + rng.gaussian(0, 0.15),
      relativeY: truth.relativeY + rng.gaussian(0, 0.6),
      relativeHeading: truth.relativeHeading + rng.gaussian(0, 0.03),
      width: 2,
      length: 4.6,
      confidence: 0.9,
      uncertainty: { lateralPosition: 0.15, longitudinalPosition: 0.6, heading: 0.03 },
    }));

    for (const [name, update] of Object.entries(updates)) {
      const tracks = update(measurements, DT, egoInput);
      if (t < WARMUP) continue;
      for (const truth of truths) {
        const track = tracks.find((candidate) => candidate.id === truth.id);
        if (!track) throw new Error(`missing track ${truth.id}`);
        expect(Number.isFinite(track.uncertainty.lateralVelocity)).toBe(true);
        expect(Number.isFinite(track.uncertainty.longitudinalVelocity)).toBe(true);
        sums[name].position += (track.relativeX - truth.relativeX) ** 2 + (track.relativeY - truth.relativeY) ** 2;
        sums[name].velocity += (track.relativeVx - truth.relativeVx) ** 2 + (track.relativeVy - truth.relativeVy) ** 2;
        sums[name].heading += normalizeAngle(track.relativeHeading - truth.relativeHeading) ** 2;
        sums[name].count += 1;
      }
    }
  }

  const result: Record<string, ErrorStats> = {};
  for (const [name, sum] of Object.entries(sums)) {
    result[name] = {
      position: Math.sqrt(sum.position / sum.count),
      velocity: Math.sqrt(sum.velocity / sum.count),
      heading: Math.sqrt(sum.heading / sum.count),
    };
  }
  return result;
}

function builtInTrackers(): Record<string, TrackerUpdate> {
  const legacy = new VehicleTracker();
  const compensated = new VehicleTracker();
  return {
    legacy: (measurements, dt) => legacy.update(measurements, dt),
    compensated: (measurements, dt, ego) => compensated.update(measurements, dt, ego),
  };
}

interface ToolboxTracker {
  update(measurements: VehicleMeasurement[], dt: number, ego?: EgoState): VehicleTrack[];
}

/** Compiles the exact toolbox source users get, so the test covers the shipped string. */
function loadToolboxTracker(): () => ToolboxTracker {
  const source = `${clampImplementation}\n${vehicleTrackerImplementation}\nexport { createVehicleTracker };`;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('exports', js)(exports);
  return exports.createVehicleTracker as () => ToolboxTracker;
}

function toolboxTrackers(): Record<string, TrackerUpdate> {
  const create = loadToolboxTracker();
  const legacy = create();
  const compensated = create();
  return {
    legacy: (measurements, dt) => legacy.update(measurements, dt),
    compensated: (measurements, dt, ego) => compensated.update(measurements, dt, ego),
  };
}

/** Target on a concentric arc around the same turn center as ego (positive yaw rate turns right). */
function arcTarget(id: string, ego: Pose, yawRate: number, lateral: number, ahead: number, speed: number): Target {
  const radius = ego.speed / yawRate;
  const targetRadius = radius - lateral;
  const angle = ahead / radius;
  // Ego heads along +y with heading 0, so a right turn's center is at +x.
  const centerX = ego.x + radius;
  const centerY = ego.y;
  return {
    id,
    x: centerX - targetRadius * Math.cos(angle),
    y: centerY + targetRadius * Math.sin(angle),
    heading: angle,
    speed,
    yawRate: speed / targetRadius,
  };
}

const egoStart: Pose = { x: 0, y: 0, heading: 0, speed: 25 };
const CURVE_YAW_RATE = 0.3;

const scenarios: Record<string, Scenario> = {
  // Road curve of radius ~83 m: a parked car, a slower lead on the curve, and
  // a faster adjacent-lane car on a concentric arc.
  'steady curve': {
    duration: 3,
    ego: egoStart,
    egoYawRate: () => CURVE_YAW_RATE,
    // Ego follows the curving lane, so its road-relative heading stays 0.
    egoRoadHeading: () => 0,
    targets: [
      { id: 'parked', x: 6, y: 95, heading: 0, speed: 0, yawRate: 0 },
      arcTarget('lead', egoStart, CURVE_YAW_RATE, 0, 40, 20),
      arcTarget('adjacent', egoStart, CURVE_YAW_RATE, -3.7, 15, 27),
    ],
  },
  // One 3.7 m lane change to the left over 3 s on a straight road while braking.
  'lane change': {
    duration: 4.5,
    ego: { ...egoStart, speed: 28 },
    egoYawRate: (t) => (t > 1 && t < 4 ? -0.092 * Math.sin((2 * Math.PI * (t - 1)) / 3) : 0),
    egoAccel: (t) => (t > 1 && t < 4 ? -1.5 : 0),
    // Straight road: road-relative heading is the world heading.
    egoRoadHeading: (ego) => ego.heading,
    targets: [
      { id: 'lead', x: 0, y: 40, heading: 0, speed: 24, yawRate: 0 },
      { id: 'left-lane', x: -3.7, y: 70, heading: 0, speed: 22, yawRate: 0 },
      { id: 'behind', x: 3.7, y: -20, heading: 0, speed: 30, yawRate: 0 },
    ],
  },
};

function format(stats: ErrorStats): string {
  return `pos ${stats.position.toFixed(3)} m, vel ${stats.velocity.toFixed(3)} m/s, heading ${((stats.heading * 180) / Math.PI).toFixed(2)} deg`;
}

describe.each([
  ['built-in VehicleTracker', builtInTrackers],
  ['toolbox createVehicleTracker', toolboxTrackers],
])('%s ego-motion compensation', (trackerName, makeTrackers) => {
  it.each(Object.keys(scenarios))('tracks targets through a %s', (scenarioName) => {
    const result = runScenario(scenarios[scenarioName], makeTrackers());
    console.info(
      `${trackerName} / ${scenarioName}\n  legacy:      ${format(result.legacy)}\n  compensated: ${format(result.compensated)}`,
    );

    expect(result.compensated.position).toBeLessThan(result.legacy.position * 0.6);
    expect(result.compensated.velocity).toBeLessThan(result.legacy.velocity * 0.5);
    expect(result.compensated.position).toBeLessThan(0.3);
    expect(result.compensated.velocity).toBeLessThan(1);
  });
});

describe('ego-motion compensation invariants', () => {
  it.each([
    ['built-in VehicleTracker', builtInTrackers],
    ['toolbox createVehicleTracker', toolboxTrackers],
  ])('%s is unaffected by ego accelerating and braking hard', (_, makeTrackers) => {
    const straight = (egoAccel: (t: number) => number): Scenario => ({
      duration: 4.5, ego: { ...egoStart, speed: 25 }, egoYawRate: () => 0, egoAccel,
      egoRoadHeading: (ego) => ego.heading,
      targets: [
        { id: 'lead', x: 0, y: 40, heading: 0, speed: 24, yawRate: 0 },
        { id: 'left-lane', x: -3.7, y: 70, heading: 0, speed: 22, yawRate: 0 },
        { id: 'behind', x: 3.7, y: -20, heading: 0, speed: 30, yawRate: 0 },
      ],
    });
    const steady = runScenario(straight(() => 0), makeTrackers());
    const pumping = runScenario(straight((t) => (Math.floor(t / 0.75) % 2 ? -4 : 4)), makeTrackers());
    const braking = runScenario(straight((t) => (t > 1.5 && t < 3 ? -7 : 0)), makeTrackers());
    for (const result of [pumping, braking]) {
      // Same noise draws as the steady run, so compensation leaves errors unchanged.
      expect(result.compensated.position).toBeCloseTo(steady.compensated.position, 3);
      expect(result.compensated.velocity).toBeCloseTo(steady.compensated.velocity, 3);
      expect(result.legacy.velocity).toBeGreaterThan(steady.legacy.velocity * 3);
    }
  });

  it('holds a parked car at zero lateral and -egoSpeed longitudinal velocity during a steady turn', () => {
    const tracker = new VehicleTracker();
    const ego: Pose = { x: 0, y: 0, heading: 0, speed: 20 };
    const parked: Target = { id: 'parked', x: 0, y: 80, heading: 0, speed: 0, yawRate: 0 };
    let track: VehicleTrack | undefined;
    for (let t = 0; t < 1.5; t += DT) {
      advance(ego, 0.25, 0);
      const truth = relativeTruth(ego, parked);
      [track] = tracker.update(
        [{
          id: truth.id,
          relativeX: truth.relativeX,
          relativeY: truth.relativeY,
          relativeHeading: truth.relativeHeading,
          width: 2,
          length: 4.6,
          confidence: 1,
          uncertainty: { lateralPosition: 0.1, longitudinalPosition: 0.3, heading: 0.02 },
        }],
        DT,
        { speed: ego.speed, yawRate: 0.25 },
      );
    }
    // In the ego frame a parked car moves at (0, -egoSpeed) by the sensor's definition.
    expect(track!.relativeVx).toBeCloseTo(0, 1);
    expect(track!.relativeVy).toBeCloseTo(-20, 1);
  });

  it('matches the legacy tracker exactly while ego drives straight at constant speed', () => {
    const legacy = new VehicleTracker();
    const straight = new VehicleTracker();
    const rng = new SeededRandom(3);
    for (let index = 0; index < 60; index += 1) {
      const measurement: VehicleMeasurement = {
        id: 'v',
        relativeX: 1 + rng.gaussian(0, 0.1),
        relativeY: 40 - index * 0.1 + rng.gaussian(0, 0.4),
        relativeHeading: 0,
        width: 2,
        length: 4.6,
        confidence: 0.9,
        uncertainty: { lateralPosition: 0.1, longitudinalPosition: 0.4, heading: 0.02 },
      };
      const [a] = legacy.update([measurement], DT);
      const [b] = straight.update([measurement], DT, { speed: 25, yawRate: 0 });
      expect(b.relativeX).toBeCloseTo(a.relativeX, 9);
      expect(b.relativeY).toBeCloseTo(a.relativeY, 9);
      expect(b.relativeVy).toBeCloseTo(a.relativeVy, 9);
    }
  });
});
