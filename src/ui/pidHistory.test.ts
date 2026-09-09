import { describe, expect, it } from 'vitest';
import { appendPidSample, pidSeriesValue } from './pidHistory';

describe('PID graph history', () => {
  it('records each observation once and bounds memory and time', () => {
    const sample = { time: 100, terms: { error: 2 } };
    const initial = appendPidSample([], sample);
    expect(appendPidSample(initial, sample)).toBe(initial);
    let history = initial;
    for (let time = 200; time <= 60_000; time += 100) history = appendPidSample(history, { time, terms: {} });
    expect(history).toHaveLength(301);
    expect(history[0].time).toBe(30_000);
    expect(history[300].time).toBe(60_000);
  });

  it('starts a fresh history when the clock resets', () => {
    expect(appendPidSample([{ time: 100, terms: { error: 3 } }], { time: 0, terms: {} })).toEqual([{ time: 0, terms: {} }]);
  });

  it('shows the sum before limiting separately from final output', () => {
    const sample = { time: 0, terms: { proportional: 2, integral: 0.5, derivative: -0.2, output: 1 } };
    expect(pidSeriesValue(sample, 'sum')).toBeCloseTo(2.3);
    expect(pidSeriesValue(sample, 'output')).toBe(1);
  });

  it('leaves gaps for unavailable or non-finite values without inventing zeros', () => {
    expect(pidSeriesValue({ time: 0, terms: { proportional: 1 } }, 'sum')).toBeUndefined();
    expect(pidSeriesValue({ time: 0, terms: { error: NaN } }, 'error')).toBeUndefined();
  });
});
