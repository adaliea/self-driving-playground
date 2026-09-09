import type { RenderTelemetry } from '../rendering';
import type { NamedPidTelemetry } from './pidTelemetry';
import { appendPidSample, type PidSample, PID_HISTORY_LIMIT, PID_HISTORY_MS } from './pidHistory';
import type { ChartSample } from './TelemetryChart';

export interface TelemetryHistory {
  version?: number;
  vehicle: ChartSample[];
  pids: Record<string, PidSample[]>;
}

export function recordTelemetry(previous: TelemetryHistory, version: number | undefined, telemetry: RenderTelemetry, controllers: NamedPidTelemetry[]): TelemetryHistory {
  const time = telemetry.time * 1000;
  const last = previous.vehicle[previous.vehicle.length - 1];
  const reset = previous.version !== version || (last !== undefined && time < last.time);
  if (!reset && last?.time === time) return previous;
  const base: TelemetryHistory = reset ? { version, vehicle: [], pids: {} } : previous;
  const values = {
    speed: telemetry.speedMph,
    leadSpeed: telemetry.leadVehicle?.speedMph,
    leadRelativeX: telemetry.leadVehicle?.relativeX,
    leadRelativeY: telemetry.leadVehicle?.relativeY,
    leadRelativeVx: telemetry.leadVehicle?.relativeVx,
    leadRelativeVy: telemetry.leadVehicle?.relativeVy,
    userMotor: telemetry.userMotor, finalMotor: telemetry.finalMotor, actualMotor: telemetry.actualMotor,
    userSteering: telemetry.userSteering, finalSteering: telemetry.finalSteering, actualSteering: telemetry.actualSteering,
  };
  return {
    version,
    vehicle: [...base.vehicle.filter((sample) => sample.time >= time - PID_HISTORY_MS), { time, values }].slice(-PID_HISTORY_LIMIT),
    pids: Object.fromEntries(controllers.map((controller) => [controller.id,
      appendPidSample(base.pids[controller.id] ?? [], { time, terms: { ...controller.terms } }),
    ])),
  };
}
