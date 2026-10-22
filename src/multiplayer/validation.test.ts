import { describe, expect, it } from 'vitest';
import { compileUserCode } from '../sandbox/compiler';
import { driverFactoryBody, driverWorkerModule } from '../sandbox/runnerSource';
import { controllerExamples } from '../toolbox/examples';
import { runValidation } from './validation';

// Drivers go through the real compiler and the same runtime wrapper the server and sandbox use.
function loadDriver(source: string): (input: unknown) => unknown {
  const compiled = compileUserCode(source);
  if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
  return new Function(driverFactoryBody(compiled.js))() as (input: unknown) => unknown;
}

const example = (id: string) => controllerExamples.find((candidate) => candidate.id === id)!.code;
// Keeps the default example's steering but overrides its throttle.
const withMotor = (motor: string) =>
  example('pid-lane-default').replace('export function autopilot', 'function steer') +
  `\nexport function autopilot(input: AutopilotInput): AutopilotOutput { return { steering: steer(input).steering, motor: ${motor} }; }`;

const SEED = 11;

describe('pre-race validation', () => {
  it.each(['pid-lane-default', 'adaptive-cruise'])('passes the %s example', async (id) => {
    const report = await runValidation(loadDriver(example(id)), { seed: SEED });
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  }, 30_000);

  it.each([
    ['a parked car', withMotor('-1'), 'blocking'],
    ['a crawling car', withMotor('input.ego.speed > 5 ? -0.3 : 0.3'), 'blocking'],
    ['a car that rams traffic ahead', withMotor('1'), 'collisions'],
  ])('rejects %s', async (_, source, check) => {
    const report = await runValidation(loadDriver(source), { seed: SEED });
    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.check)).toContain(check);
  }, 30_000);

  it('stops early and rejects a driver that always throws', async () => {
    const autopilot = loadDriver(`export function autopilot(input: AutopilotInput): AutopilotOutput { throw new Error('boom'); }`);
    const report = await runValidation(autopilot, { seed: SEED });
    expect(report).toMatchObject({ passed: false, firstError: 'boom', issues: [{ check: 'errors' }] });
  });

  it('rejects a run that misses its deadline', async () => {
    const report = await runValidation(() => ({ motor: 1, steering: 0 }), { seed: SEED, deadline: Date.now() - 1 });
    expect(report).toMatchObject({ passed: false, issues: [{ check: 'timeout' }] });
  });

  it('builds a driver worker module with the sandbox helpers', () => {
    const module = driverWorkerModule('exports.autopilot = () => ({ motor: 0, steering: 0 });');
    expect(module).toContain('function analyzeLaneRegression');
    expect(module).toContain('export default class Driver');
  });
});
