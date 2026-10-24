import { describe, expect, it } from 'vitest';
import { compileUserCode } from './compiler';
import { runnerHelpers } from './runnerSource';

interface ExecutedController {
  autopilot: (input: Record<string, unknown>) => unknown;
  calls: Record<string, { name: string; args: unknown[]; result: unknown }>;
  values: Record<string, unknown>;
}

describe('runtime inspection compiler transform', () => {
  it('captures parameters, locals, property-producing helpers, and control-focused toolbox calls', () => {
    const result = compileUserCode(`
export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = clamp(lane.centerOffset, -1, 1);
  return { motor: 0, steering };
}`);

    expect(result.errors).toEqual([]);
    expect(result.inspection.bindings.map((binding) => binding.name)).toEqual(['input', 'lane', 'steering']);
    expect(result.inspection.toolboxCalls.map((call) => call.name)).toEqual(['analyzeLane', 'clamp']);

    const executed = execute(result.js);
    executed.autopilot({
      dt: 1 / 45,
      ego: { speed: 20, heading: 0, laneIndex: 1 },
      vehicles: [],
      laneLines: {
        left: [{ x: -1.5, y: 12, confidence: 1 }],
        right: [{ x: 2, y: 12, confidence: 1 }],
        farLeft: [],
        farRight: [],
      },
    });

    const laneBinding = result.inspection.bindings.find((binding) => binding.name === 'lane')!;
    const steeringBinding = result.inspection.bindings.find((binding) => binding.name === 'steering')!;
    expect(executed.values[laneBinding.id]).toMatchObject({ centerOffset: 0.25 });
    expect(executed.values[steeringBinding.id]).toBe(0.25);
    expect(executed.calls[laneBinding.sourceCallId!].name).toBe('analyzeLane');
  });

  it('preserves single evaluation and captures assignments and postfix updates', () => {
    const result = compileUserCode(`
let evaluations = 0;
function once() { evaluations += 1; return 2; }
export function autopilot(input: AutopilotInput): AutopilotOutput {
  let value = once();
  value += input.dt;
  value++;
  return { motor: evaluations, steering: value };
}`);
    const executed = execute(result.js);
    const output = executed.autopilot({ dt: 1 }) as { motor: number; steering: number };
    const valueBinding = result.inspection.bindings.find((binding) => binding.name === 'value')!;

    expect(output).toMatchObject({ motor: 1, steering: 4 });
    expect(executed.values[valueBinding.id]).toBe(4);
  });

  it('does not special-case a locally shadowed toolbox function', () => {
    const result = compileUserCode(`
function clamp(value: number): number { return value * 2; }
export function autopilot(): AutopilotOutput {
  const motor = clamp(0.25);
  return { motor, steering: 0 };
}`);

    expect(result.inspection.toolboxCalls).toEqual([]);
    expect((execute(result.js).autopilot({}) as { motor: number }).motor).toBe(0.5);
  });

  it('warns when a PID controller is created inside a function, where it resets every tick', () => {
    const inside = compileUserCode(`
export function autopilot(input: AutopilotInput): AutopilotOutput {
  const pid = createPidController({ kp: 1, ki: 0, kd: 0 });
  return { motor: pid.update(1, input.dt), steering: 0 };
}`);
    expect(inside.ok).toBe(true);
    expect(inside.warnings).toHaveLength(1);
    expect(inside.warnings[0].message).toContain('every time the function runs');
    const source = 'createPidController({ kp: 1, ki: 0, kd: 0 })';
    expect(inside.warnings[0]).toMatchObject({ length: source.length });

    const outside = compileUserCode(`
const pid = createPidController({ kp: 1, ki: 0, kd: 0 });
export function autopilot(input: AutopilotInput): AutopilotOutput {
  return { motor: pid.update(1, input.dt), steering: 0 };
}`);
    expect(outside.warnings).toEqual([]);
  });

  it('warns about a + term that landed after the semicolon and does nothing', () => {
    const result = compileUserCode(`
export function autopilot(input: AutopilotInput): AutopilotOutput {
  const steering = clamp(1, -1, 1); + clamp(2, -1, 1);
  return { motor: 0, steering };
}`);
    expect(result.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('This line does nothing')]);
  });
});

function execute(js: string): ExecutedController {
  const values: Record<string, unknown> = {};
  const calls: Record<string, { name: string; args: unknown[]; result: unknown }> = {};
  const run = new Function(
    '__playgroundTraceValue',
    '__playgroundTracePostfix',
    '__playgroundTraceToolboxCall',
    'values',
    'calls',
    `
      const exports = {};
      const module = { exports };
      ${runnerHelpers()}
      ${js}
      return { autopilot: module.exports.autopilot || exports.autopilot };
    `,
  ) as (...args: unknown[]) => { autopilot: ExecutedController['autopilot'] };

  const traced = run(
    (id: string, value: unknown) => {
      values[id] = value;
      return value;
    },
    (id: string, readCurrent: () => unknown, result: unknown) => {
      values[id] = readCurrent();
      return result;
    },
    (id: string, name: string, fn: (...args: unknown[]) => unknown, args: unknown[]) => {
      const result = fn(...args);
      calls[id] = { name, args, result };
      return result;
    },
    values,
    calls,
  );
  return { ...traced, values, calls };
}
