import type { ChartSample, ChartSeries } from './TelemetryChart';
import type { NamedPidTelemetry } from './pidTelemetry';
import { graphSignalKey, type TelemetryHistory } from './telemetryHistory';
import { pidSeriesValue, type PidSeries } from './pidHistory';
import { colorblindPalette as cb, pidTermColorblindStyle, type LinePattern } from './chartStyles';

export interface TelemetrySignal extends ChartSeries { group: string }
export const defaultSignals = ['speed', 'actualMotor', 'actualSteering'];
const colors = ['#38bdf8', '#fbbf24', '#34d399', '#fb7185', '#c4b5fd', '#e2e8f0', '#fb923c'];
// Colorblind-friendly mode: motor and steering each keep one hue, and the pipeline stage is the pattern.
const stagePatterns: LinePattern[] = ['solid', 'dashed', 'dotted'];
const pidTerms: [PidSeries, string][] = [['error', 'Error'], ['proportional', 'P'], ['integral', 'I'], ['derivative', 'D'], ['sum', 'P + I + D'], ['output', 'Output']];
const graphColorblindColors = [cb.blue, cb.orange, cb.aqua, cb.yellow, cb.magenta, cb.green, cb.violet, cb.red];
export function telemetrySignals(controllers: NamedPidTelemetry[], graphs: Record<string, string | undefined> = {}): TelemetrySignal[] {
  return [
    { key: 'speed', label: 'Speed', group: 'Vehicle', axis: 'mph', color: colors[0], colorblindColor: cb.blue, pattern: 'solid' },
    // Lead signals share the dash-dot pattern; lead speed reuses the speed hue so the two read as a pair.
    { key: 'leadSpeed', label: 'Lead · estimated forward speed (mph)', group: 'Lead vehicle', axis: 'mph', color: '#fbbf24', colorblindColor: cb.blue, pattern: 'dashdot' },
    { key: 'leadRelativeY', label: 'Lead · distance ahead (m)', group: 'Lead vehicle', axis: 'm', color: '#34d399', colorblindColor: cb.violet, pattern: 'dashdot' },
    { key: 'leadRelativeX', label: 'Lead · lateral offset (m, +right)', group: 'Lead vehicle', axis: 'm', color: '#c4b5fd', colorblindColor: cb.magenta, pattern: 'dashdot' },
    { key: 'leadRelativeVy', label: 'Lead · relative forward velocity (m/s)', group: 'Lead vehicle', axis: 'm/s', color: '#fb7185', colorblindColor: cb.green, pattern: 'dashdot' },
    { key: 'leadRelativeVx', label: 'Lead · relative lateral velocity (m/s, +right)', group: 'Lead vehicle', axis: 'm/s', color: '#fb923c', colorblindColor: cb.red, pattern: 'dashdot' },
    ...(['Motor', 'Steering'] as const).flatMap((axis, axisIndex) => (['user', 'final', 'actual'] as const).map((stage, index) => ({
      key: `${stage}${axis}`, label: `${axis} · ${['autopilot', 'after assists', 'actual'][index]}`,
      group: axis, axis: 'Command', color: colors[(index + axisIndex * 3 + 1) % colors.length],
      colorblindColor: axis === 'Motor' ? cb.orange : cb.aqua, pattern: stagePatterns[index],
    }))),
    ...controllers.flatMap((controller, controllerIndex) => pidTerms.map(([term, label], index) => ({
      key: `pid:${controller.id}:${term}`, label: `${controller.name} · ${label}`, group: controller.name,
      axis: term === 'error' ? 'Error' : 'Command', color: colors[(index + controllerIndex) % colors.length],
      ...pidTermColorblindStyle[term],
    }))),
    // graph(name, value, unit?) series share an axis per unit; without one, each gets its own scale.
    ...Object.entries(graphs).map(([name, unit], index) => ({
      key: graphSignalKey(name), label: unit ? `${name} (${unit})` : name, group: 'graph()', axis: unit ?? name,
      color: colors[index % colors.length], colorblindColor: graphColorblindColors[index % graphColorblindColors.length], pattern: 'solid' as const,
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
