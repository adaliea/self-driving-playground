import type { ChartSample, ChartSeries } from './TelemetryChart';
import type { NamedPidTelemetry } from './pidTelemetry';
import { graphSignalKey, type TelemetryHistory } from './telemetryHistory';
import { pidSeriesValue, type PidSeries } from './pidHistory';

/** A selectable signal. Its line style is assigned when selected, so the chosen set never shares a style. */
export interface TelemetrySignal extends Pick<ChartSeries, 'key' | 'label' | 'axis'> { group: string }
export const defaultSignals = ['speed', 'actualMotor', 'actualSteering'];
const pidTerms: [PidSeries, string][] = [['error', 'Error'], ['proportional', 'P'], ['integral', 'I'], ['derivative', 'D'], ['sum', 'P + I + D'], ['output', 'Output']];
export function telemetrySignals(controllers: NamedPidTelemetry[], graphs: Record<string, string | undefined> = {}): TelemetrySignal[] {
  return [
    { key: 'speed', label: 'Speed (m/s)', group: 'Vehicle', axis: 'm/s' },
    { key: 'leadSpeed', label: 'Lead · estimated forward speed (m/s)', group: 'Lead vehicle', axis: 'm/s' },
    { key: 'leadRelativeY', label: 'Lead · distance ahead (m)', group: 'Lead vehicle', axis: 'm' },
    { key: 'leadRelativeX', label: 'Lead · lateral offset (m, +right)', group: 'Lead vehicle', axis: 'm' },
    { key: 'leadRelativeVy', label: 'Lead · relative forward velocity (m/s)', group: 'Lead vehicle', axis: 'm/s' },
    { key: 'leadRelativeVx', label: 'Lead · relative lateral velocity (m/s, +right)', group: 'Lead vehicle', axis: 'm/s' },
    ...(['Motor', 'Steering'] as const).flatMap((axis) => (['user', 'final', 'actual'] as const).map((stage, index) => ({
      key: `${stage}${axis}`, label: `${axis} · ${['autopilot', 'after assists', 'actual'][index]}`,
      group: axis, axis: 'Command',
    }))),
    ...controllers.flatMap((controller) => pidTerms.map(([term, label]) => ({
      key: `pid:${controller.id}:${term}`, label: `${controller.name} · ${label}`, group: controller.name,
      axis: term === 'error' ? 'Error' : 'Command',
    }))),
    // graph(name, value, unit?) series share an axis per unit; without one, each gets its own scale.
    ...Object.entries(graphs).map(([name, unit]) => ({
      key: graphSignalKey(name), label: unit ? `${name} (${unit})` : name, group: 'graph()', axis: unit ?? name,
    })),
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
