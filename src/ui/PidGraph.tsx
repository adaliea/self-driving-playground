import { TelemetryChart, type ChartSeries } from './TelemetryChart';
import { pidSeriesValue, type PidSample, type PidSeries } from './pidHistory';

const series: (ChartSeries & { key: PidSeries })[] = [
  { key: 'error', label: 'Error', color: '#fbbf24', dash: '5 3' },
  { key: 'proportional', label: 'P', color: '#38bdf8' },
  { key: 'integral', label: 'I', color: '#34d399', dash: '6 2' },
  { key: 'derivative', label: 'D', color: '#fb7185', dash: '2 3' },
  { key: 'sum', label: 'P + I + D', color: '#c4b5fd', dash: '7 4' },
  { key: 'output', label: 'Output', color: '#e2e8f0' },
];

export function PidGraph({ name, history }: { name: string; history: PidSample[] }) {
  return <TelemetryChart name={name} history={history.map((sample) => ({
    time: sample.time,
    values: Object.fromEntries(series.map((item) => [item.key, pidSeriesValue(sample, item.key)])),
  }))} series={series} panels={[
    { keys: ['error'], top: 23, bottom: 91, label: 'ERROR · INDEPENDENT SCALE' },
    { keys: ['proportional', 'integral', 'derivative', 'sum', 'output'], top: 125, bottom: 237, label: 'OUTPUT CONTRIBUTIONS' },
  ]} note="Output = P + I + D, then limited" />;
}
