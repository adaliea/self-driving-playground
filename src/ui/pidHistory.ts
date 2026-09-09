import type { PidDebugTerms } from '../types';

export interface PidSample {
  time: number;
  terms: Partial<PidDebugTerms>;
}

export const PID_HISTORY_MS = 30_000;
export const PID_HISTORY_LIMIT = 301;

export function appendPidSample(history: PidSample[], sample: PidSample): PidSample[] {
  if (history.length && sample.time === history[history.length - 1].time) return history;
  if (history.length && sample.time < history[history.length - 1].time) return [sample];
  return [...history.filter((point) => point.time >= sample.time - PID_HISTORY_MS), sample].slice(-PID_HISTORY_LIMIT);
}

export type PidSeries = keyof PidDebugTerms | 'sum';
export function pidSeriesValue(sample: PidSample, key: PidSeries): number | undefined {
  const { proportional: p, integral: i, derivative: d } = sample.terms;
  const value = key === 'sum'
    ? p === undefined || i === undefined || d === undefined ? undefined : p + i + d
    : sample.terms[key];
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
