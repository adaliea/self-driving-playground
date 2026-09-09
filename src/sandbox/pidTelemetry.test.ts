import sandboxHtml from '../../public/sandbox.html?raw';
import { describe, expect, it } from 'vitest';
import { compileUserCode } from './compiler';
import type { RuntimeInspectionSnapshot } from './inspection';
import { pidTelemetryFromInspection } from '../ui/pidTelemetry';

const source = `
const positionPid = createPidController({
  kp: 0.35, ki: 0.0, kd: 0.0,
  outputMin: -1, outputMax: 0.0,
  integralMin: -0.1, integralMax: 0.1,
});
export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lead = closestVehicleAhead(input.vehicles, input.ego.laneIndex);
  let motor;
  if (lead) {
    let targetSpeed = lead.relativeVy + input.ego.speed;
    motor = accelerationFeedforward(targetSpeed, targetSpeed)
      + positionPid.update(lead.relativeY - 10, input.dt);
  } else {
    motor = 1;
  }
  const lane = analyzeLane(input.laneLines);
  return { motor, steering: clamp(0, -1, 1), targetLane: input.targetLane };
}`;

describe('conditional PID sandbox telemetry', () => {
  it('retains the position controller and its latest terms when the lead disappears', () => {
    const compiled = compileUserCode(source);
    expect(compiled.errors).toEqual([]);
    // Execute the production worker source, including its observation serializer.
    const template = sandboxHtml.match(/const workerSource = (`[\s\S]*?`);\s*const blob/)!;
    expect(template).not.toBeNull();
    const workerSource = new Function('code', 'version', `return ${template[1]}`)(compiled.js, 1);
    let now = 1000;
    const messages: { type: string; inspection?: RuntimeInspectionSnapshot; message?: string }[] = [];
    const worker = {
      postMessage: (message: typeof messages[number]) => messages.push(message),
      onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    };
    new Function('self', 'performance', 'Date', workerSource)(
      worker, { now: () => now }, { now: () => now },
    );
    expect(messages[0].type).toBe('worker-loaded');

    let previousTerms;
    for (const [id, distance] of [undefined, 8, undefined, 12, undefined].entries()) {
      now += 110;
      worker.onmessage!({ data: {
        type: 'run-autopilot', id,
        input: {
          dt: 1 / 45,
          ego: { laneIndex: 1, speed: 20 }, targetLane: 1,
          vehicles: distance === undefined ? [] : [{ laneIndex: 1, relativeY: distance, relativeVy: -1 }],
          laneLines: { left: [], right: [], farLeft: [], farRight: [] },
        },
      } });
      const message = messages[messages.length - 1];
      expect(message.type, message.message).toBe('worker-result');
      const cards = pidTelemetryFromInspection({
        version: 1, running: true, manifest: compiled.inspection, snapshot: message.inspection,
      });
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe('positionPid');
      if (distance === undefined && previousTerms) expect(cards[0].terms).toEqual(previousTerms);
      if (distance !== undefined) expect(cards[0].terms.error).toBe(distance - 10);
      previousTerms = cards[0].terms;
    }
  });
});
