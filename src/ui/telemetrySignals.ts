import type { ChartSample, ChartSeries } from './TelemetryChart';
import type { NamedPidTelemetry } from './pidTelemetry';
import type { TelemetryHistory } from './telemetryHistory';
import { pidSeriesValue, type PidSeries } from './pidHistory';

export interface TelemetrySignal extends ChartSeries { group: string }
export const defaultSignals = ['speed', 'actualMotor', 'actualSteering'];
const colors = ['#38bdf8', '#fbbf24', '#34d399', '#fb7185', '#c4b5fd', '#e2e8f0', '#fb923c'];
const pidTerms: [PidSeries, string][] = [['error', 'Error'], ['proportional', 'P'], ['integral', 'I'], ['derivative', 'D'], ['sum', 'P + I + D'], ['output', 'Output']];
export function telemetrySignals(controllers: NamedPidTelemetry[]): TelemetrySignal[] {
  return [
    { key: 'speed', label: 'Speed', group: 'Vehicle', axis: 'mph', color: colors[0] },
    { key: 'leadSpeed', label: 'Lead · estimated forward speed (mph)', group: 'Lead vehicle', axis: 'mph', color: '#fbbf24' },
    { key: 'leadRelativeY', label: 'Lead · distance ahead (m)', group: 'Lead vehicle', axis: 'm', color: '#34d399' },
    { key: 'leadRelativeX', label: 'Lead · lateral offset (m, +right)', group: 'Lead vehicle', axis: 'm', color: '#c4b5fd' },
    { key: 'leadRelativeVy', label: 'Lead · relative forward velocity (m/s)', group: 'Lead vehicle', axis: 'm/s', color: '#fb7185' },
    { key: 'leadRelativeVx', label: 'Lead · relative lateral velocity (m/s, +right)', group: 'Lead vehicle', axis: 'm/s', color: '#fb923c' },
    ...(['Motor', 'Steering'] as const).flatMap((axis, axisIndex) => (['user', 'final', 'actual'] as const).map((stage, index) => ({
      key: `${stage}${axis}`, label: `${axis} · ${['autopilot', 'after assists', 'actual'][index]}`,
      group: axis, axis: 'Command', color: colors[(index + axisIndex * 3 + 1) % colors.length], dash: index === 1 ? 'dashed' : undefined,
    }))),
    ...controllers.flatMap((controller, controllerIndex) => pidTerms.map(([term, label], index) => ({
      key: `pid:${controller.id}:${term}`, label: `${controller.name} · ${label}`, group: controller.name,
      axis: term === 'error' ? 'Error' : 'Command', color: colors[(index + controllerIndex) % colors.length], dash: term === 'sum' ? 'dashed' : undefined,
    }))),
  ];
}
export function telemetrySamples(history: TelemetryHistory): ChartSample[] {
  const samples = new Map(history.vehicle.map((sample) => [sample.time, { time: sample.time, values: { ...sample.values } }]));
  for (const [id, points] of Object.entries(history.pids)) for (const point of points) {
    const sample = samples.get(point.time) ?? { time: point.time, values: {} };
    for (const [term] of pidTerms) sample.values[`pid:${id}:${term}`] = pidSeriesValue(point, term);
    samples.set(point.time, sample);
  }
  return [...samples.values()].sort((a, b) => a.time - b.time);
}
