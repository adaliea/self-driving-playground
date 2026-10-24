import { describe, expect, it } from 'vitest';
import type { RenderTelemetry } from '../rendering';
import { recordTelemetry, type TelemetryHistory } from './telemetryHistory';

const telemetry: RenderTelemetry = {
  time: 1, speed: 10, speedMph: 22.4, laneIndex: 1,
  userMotor: 0.3, finalMotor: 0.5, actualMotor: 0.4,
  userSteering: 0.1, finalSteering: 0.2, actualSteering: 0.15,
  steerOverridden: true, motorOverridden: true, invalidFields: [], collisions: 0,
};
const initial: TelemetryHistory = { vehicle: [], pids: {} };
const controllers = [{ id: 'position', name: 'positionPid', terms: { error: 2, proportional: 0.7, output: 0 } }];

describe('shared telemetry recording', () => {
  it('captures speed, each actuation stage, and PID terms on one timeline', () => {
    const history = recordTelemetry(initial, 1, telemetry, controllers);
    expect(history.vehicle[0]).toMatchObject({ time: 1000, values: {
      speed: 10, userMotor: 0.3, finalMotor: 0.5, actualMotor: 0.4,
      userSteering: 0.1, finalSteering: 0.2, actualSteering: 0.15,
    } });
    expect(history.pids.position[0]).toEqual({ time: 1000, terms: controllers[0].terms });
    expect(recordTelemetry(history, 1, telemetry, controllers)).toBe(history);
  });

  it('clears history after reset or a new program, including removed controllers', () => {
    const history = recordTelemetry(initial, 1, telemetry, controllers);
    expect(recordTelemetry(history, 2, telemetry, []).pids).toEqual({});
    const reset = recordTelemetry(history, 1, { ...telemetry, time: 0 }, controllers);
    expect(reset.vehicle.map((sample) => sample.time)).toEqual([0]);
    expect(reset.pids.position.map((sample) => sample.time)).toEqual([0]);
  });

  it('records lead signals and leaves gaps when the lead is lost', () => {
    const leadVehicle = { id: 'lead', speed: 35, relativeX: 0.2, relativeY: 12, relativeVx: 0.1, relativeVy: -2 };
    const history = recordTelemetry(initial, 1, { ...telemetry, leadVehicle }, controllers);
    expect(history.vehicle[0].values).toMatchObject({ leadSpeed: 35, leadRelativeY: 12, leadRelativeX: 0.2, leadRelativeVy: -2, leadRelativeVx: 0.1 });
    const lost = recordTelemetry(history, 1, { ...telemetry, time: 2 }, controllers);
    expect(lost.vehicle[1].values.leadSpeed).toBeUndefined();
    expect(lost.vehicle[1].values.leadRelativeY).toBeUndefined();
  });

  it('bounds stored history and keeps a held snapshot immutable', () => {
    const held = recordTelemetry(initial, 1, telemetry, controllers);
    let history = held;
    for (let time = 2; time <= 40; time++) history = recordTelemetry(history, 1, { ...telemetry, time }, controllers);
    expect(history.vehicle[0].time).toBe(10_000);
    expect(history.pids.position[0].time).toBe(10_000);
    expect(held.vehicle).toHaveLength(1);
    expect(held.pids.position).toHaveLength(1);
  });

  it('records graph(...) values as signals and remembers each series and unit until reset', () => {
    const first = recordTelemetry(initial, 1, { ...telemetry, graphs: { gap: { value: 12, unit: 'm' }, braking: { value: 1 } } }, []);
    expect(first.vehicle[0].values).toMatchObject({ 'graph:gap': 12, 'graph:braking': 1 });
    const second = recordTelemetry(first, 1, { ...telemetry, time: 2 }, []);
    expect(second.vehicle[1].values['graph:gap']).toBeUndefined();
    expect(second.graphs).toEqual({ gap: 'm', braking: undefined });
    expect(recordTelemetry(second, 2, telemetry, []).graphs).toEqual({});
  });
});
