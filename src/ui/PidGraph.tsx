import { pidTermColorblindStyle } from './chartStyles';
import { TelemetryChart, type ChartSeries } from './TelemetryChart';
import { pidSeriesValue, type PidSample, type PidSeries } from './pidHistory';

const series: (ChartSeries & { key: PidSeries })[] = [
  { key: 'error', label: 'Error', color: '#fbbf24' },
  { key: 'proportional', label: 'P', color: '#38bdf8' },
  { key: 'integral', label: 'I', color: '#34d399' },
  { key: 'derivative', label: 'D', color: '#fb7185' },
  { key: 'sum', label: 'P + I + D', color: '#c4b5fd' },
  { key: 'output', label: 'Output', color: '#e2e8f0' },
].map((item) => ({ ...item, ...pidTermColorblindStyle[item.key as PidSeries] }) as ChartSeries & { key: PidSeries });

export function PidGraph({ name, history }: { name: string; history: PidSample[] }) {
  return <TelemetryChart name={name} history={history.map((sample) => ({
    time: sample.time,
    values: Object.fromEntries(series.map((item) => [item.key, pidSeriesValue(sample, item.key)])),
  }))} series={series} panels={[
    { keys: ['error'], top: 23, bottom: 91, label: 'Error' },
    { keys: ['proportional', 'integral', 'derivative', 'sum', 'output'], top: 125, bottom: 237, label: 'Output contributions' },
  ]} legend note="Output = P + I + D, then limited" />;
}
