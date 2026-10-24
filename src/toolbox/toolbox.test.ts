import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { compileUserCode } from '../sandbox/compiler';
import { driverFactoryBody } from '../sandbox/runnerSource';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP, Simulation } from '../simulation';
import {
  brakingStarterExample,
  pidCheckpointExample,
  raceReadyExample,
  starterExample,
  steeringPidCheckpointExample,
  tunedFollowingExample,
  tunedSteeringExample,
} from './examples';
import { clampImplementation, pidControllerImplementation, toolboxLibrarySource, visibleToolboxSource } from './library';
import { snippetInsertion, toolboxSnippets } from './snippets';

function loadDriver(source: string): (input: unknown) => { motor: number; steering: number } {
  const compiled = compileUserCode(source);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Function(driverFactoryBody(compiled.js))() as (input: unknown) => { motor: number; steering: number };
}

/** Mean lateral distance from the lane center over a solo drive, in meters. */
function laneErrorRms(source: string, seconds = 40): number {
  const drive = loadDriver(source);
  const settings = { ...DEFAULT_SETTINGS, seed: 42, trafficDensity: 0 };
  const simulation = new Simulation(settings);
  const internals = simulation as unknown as {
    vehicles: { kind: string; lateral: number; laneIndex: number }[];
    road: { getLaneCenterOffset(lane: number): number };
  };
  let sum = 0;
  let count = 0;
  for (let step = 0; step < seconds / FIXED_TIMESTEP; step += 1) {
    simulation.step(FIXED_TIMESTEP, drive(simulation.createEgoInput(settings, FIXED_TIMESTEP)), settings);
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego')!;
    if (step * FIXED_TIMESTEP < 3) continue;
    sum += (ego.lateral - internals.road.getLaneCenterOffset(ego.laneIndex)) ** 2;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

describe('toolbox locking', () => {
  it('shows every helper when nothing is locked', () => {
    expect(visibleToolboxSource([])).toBe(toolboxLibrarySource);
  });

  it('hides locked helpers but keeps ones an unlocked helper calls', () => {
    const source = visibleToolboxSource(['lateral-velocity', 'steering-feedforward', 'adaptive-cruise']);
    expect(source).not.toContain('function lateralVelocitySteering');
    expect(source).not.toContain('function adaptiveCruiseTargetSpeed');
    expect(source).not.toContain('function steeringFeedforward');

    const needed = visibleToolboxSource(['steering-feedforward']);
    expect(needed).toContain('function lateralVelocitySteering');
    expect(needed).toContain('function steeringFeedforward');
  });

  it('always keeps clamp', () => {
    expect(visibleToolboxSource(toolboxSnippets.map((snippet) => snippet.id))).toContain('function clamp');
  });
});

describe('PID derivative smoothing', () => {
  const create = new Function(
    ts.transpileModule(`${clampImplementation}\n${pidControllerImplementation}\nreturn createPidController;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText,
  )() as (options: Record<string, number>) => { update(error: number, dt: number): number };

  it('softens the derivative kick from a sudden jump in error', () => {
    const raw = create({ kp: 0, ki: 0, kd: 1, derivativeSmoothing: 0 });
    const smoothed = create({ kp: 0, ki: 0, kd: 1 });
    for (const pid of [raw, smoothed]) pid.update(0, 0.02);
    expect(raw.update(1, 0.02)).toBeCloseTo(50, 6);
    expect(smoothed.update(1, 0.02)).toBeLessThan(20);
  });
});

describe('talk starter', () => {
  it('compiles and drives with no car ahead', () => {
    const drive = loadDriver(starterExample.code);
    const output = drive({
      dt: 1 / 45,
      ego: { speed: 20, heading: 0, lateralVelocity: 0, yawRate: 0, laneIndex: 1 },
      vehicles: [],
      vehicleMeasurements: [],
      laneLines: { left: [], right: [], farLeft: [], farRight: [] },
    });
    expect(output.motor).toBe(0.5);
    expect(starterExample.recommendedSettings).toMatchObject({ steerAssist: true });
  });

  it('builds the braking and catch-up checkpoints on top of it', () => {
    expect(brakingStarterExample.code).toContain('if (closestVehicleDistance < TOO_CLOSE_DISTANCE) {\n    motor = -1;');
    expect(pidCheckpointExample.code).toContain('TOO_CLOSE_DISTANCE');
    expect(pidCheckpointExample.code).toContain('// TODO: Replace this with a PID loop');
    for (const example of [brakingStarterExample, pidCheckpointExample]) expect(compileUserCode(example.code).ok).toBe(true);
  });

  it('builds each steering checkpoint from the one before it', () => {
    const chain = [
      [tunedFollowingExample, steeringPidCheckpointExample, '// TODO: Steer with a PID'],
      [tunedFollowingExample, tunedSteeringExample, 'lanePid.update(lane.centerOffset, input.dt)'],
      [tunedSteeringExample, raceReadyExample, 'steeringFeedforward(lane.curvature, input.ego.speed)'],
    ] as const;
    for (const [base, next, added] of chain) {
      expect(next.code).not.toBe(base.code);
      expect(next.code).toContain(added);
      expect(compileUserCode(next.code).ok).toBe(true);
    }
  });
});

describe('lateral velocity steering', () => {
  it('holds the lane when an outer P loop on lane offset picks the sideways speed', () => {
    const rms = laneErrorRms(`const lateralPid = createPidController({ kp: 1, ki: 0, kd: 0, outputMin: -1.5, outputMax: 1.5 });
export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const targetLateralVelocity = lateralPid.update(lane.centerOffset, input.dt);
  return {
    motor: speedFeedforward(26) + (26 - input.ego.speed) * 0.1,
    steering: lateralVelocitySteering(input, targetLateralVelocity),
  };
}`);
    expect(rms).toBeLessThan(0.15);
  }, 30_000);
});

describe('PID snippet naming', () => {
  const pid = toolboxSnippets.find((snippet) => snippet.id === 'pid-controller')!;
  const declaredName = (source: string) => /const (\w+) = createPidController/.exec(snippetInsertion(pid, source).setup![0])![1];

  it('names the first PID distancePid, the second lanePid, and later ones after a random word', () => {
    expect(declaredName('')).toBe('distancePid');
    expect(declaredName('const distancePid = createPidController({ kp: 1, ki: 0, kd: 0 });')).toBe('lanePid');
    const both = 'const distancePid = 1;\nconst lanePid = 2;';
    const insertion = snippetInsertion(pid, both);
    const third = /const (\w+) = createPidController/.exec(insertion.setup![0])![1];
    expect(third).toMatch(/^[a-z]+Pid$/);
    expect(['distancePid', 'lanePid']).not.toContain(third);
    expect(insertion.usage).toContain(`${third}.update(`);
  });

  it('inserts just the update call, using targetDistance when the code has one', () => {
    expect(snippetInsertion(pid, '').usage).toBe('distancePid.update(closestVehicleDistance - 30, input.dt)');
    expect(snippetInsertion(pid, 'const targetDistance = 20;').usage).toBe('distancePid.update(closestVehicleDistance - targetDistance, input.dt)');
    expect(snippetInsertion(pid, 'const distancePid = 1;\nconst lane = 2;').usage).toBe('lanePid.update(lane.centerOffset, input.dt)');
  });
});
