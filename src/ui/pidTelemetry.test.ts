import { describe, expect, it } from 'vitest';
import { compileUserCode } from '../sandbox/compiler';
import type { RuntimeInspectionState } from '../sandbox/RuntimeInspectionStore';
import type { RuntimeValuePreview } from '../sandbox/inspection';
import { pidTelemetryFromInspection } from './pidTelemetry';

function observedState(): RuntimeInspectionState {
  const result = compileUserCode(`
const headingController = createPidController({ kp: 1, ki: 0, kd: 0 });
const velocityController = createPidController({ kp: 2, ki: 0, kd: 0 });
export function autopilot(input: AutopilotInput): AutopilotOutput {
  return { motor: velocityController.update(0.2, input.dt), steering: headingController.update(0.1, input.dt) };
}`);
  expect(result.errors).toEqual([]);
  const toolboxCalls = Object.fromEntries(result.inspection.toolboxCalls.map((call) => [call.id, {
    id: call.id, name: call.name, observedAt: 1, args: [],
    result: { type: 'undefined' } as RuntimeValuePreview,
    details: { debug: {
      type: 'object',
      properties: Object.fromEntries(['error', 'proportional', 'integral', 'derivative', 'output'].map((key) => [key, { type: 'number', value: 0.2 }])),
    } as RuntimeValuePreview },
  }]));
  return { version: 1, running: true, manifest: result.inspection, snapshot: { version: 1, capturedAt: 1, bindings: {}, toolboxCalls } };
}

describe('automatic PID telemetry', () => {
  it('labels every controller with its variable name without debug options or output fields', () => {
    const controllers = pidTelemetryFromInspection(observedState());
    expect(controllers.map((controller) => controller.name)).toEqual(['headingController', 'velocityController']);
    expect(controllers[0].terms.output).toBe(0.2);
  });

  it('clears old telemetry when a program is replaced', () => {
    const state = observedState();
    expect(pidTelemetryFromInspection({ ...state, version: 2 })).toEqual([]);
    expect(pidTelemetryFromInspection({ ...state, manifest: { bindings: [], toolboxCalls: [] }, snapshot: undefined })).toEqual([]);
  });

  it('keeps controller identities stable before and between valid observations', () => {
    const state = observedState();
    const valid = pidTelemetryFromInspection(state);
    const waiting = pidTelemetryFromInspection({ ...state, snapshot: undefined });
    expect(waiting.map(({ id }) => id)).toEqual(valid.map(({ id }) => id));
    expect(waiting.every(({ terms }) => Object.keys(terms).length === 0)).toBe(true);
    const firstCall = Object.values(state.snapshot!.toolboxCalls)[0];
    const debug = firstCall.details!.debug;
    if (debug.type !== 'object') throw new Error('Expected object');
    debug.properties.integral = { type: 'number', value: 'NaN' };
    const partial = pidTelemetryFromInspection(state);
    expect(partial.map(({ id }) => id)).toEqual(valid.map(({ id }) => id));
    expect(partial[0].terms).toEqual({ error: 0.2, proportional: 0.2, derivative: 0.2, output: 0.2 });
  });

  it('keeps cards visible with placeholders for unavailable or non-finite terms', () => {
    const state = observedState();
    for (const call of Object.values(state.snapshot!.toolboxCalls)) {
      call.details!.debug = { type: 'object', properties: { error: { type: 'number', value: 'NaN' } } };
    }
    expect(pidTelemetryFromInspection(state).map(({ name, terms }) => ({ name, terms }))).toEqual([
      { name: 'headingController', terms: {} },
      { name: 'velocityController', terms: {} },
    ]);
  });
});
