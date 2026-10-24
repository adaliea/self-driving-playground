import { describe, expect, it } from 'vitest';
import { telemetrySamples, telemetrySignals } from './telemetrySignals';

describe('selectable telemetry signals', () => {
  it('exposes all vehicle stages and each controller term with unique keys', () => {
    const signals = telemetrySignals([{ id: 'c:10', name: 'positionPid', terms: {} }, { id: 'c:20', name: 'speedPid', terms: {} }]);
    expect(signals).toHaveLength(24);
    expect(new Set(signals.map((signal) => signal.key)).size).toBe(24);
    expect(signals.find((signal) => signal.key === 'pid:c:10:sum')?.label).toBe('positionPid · P + I + D');
    expect(signals.find((signal) => signal.key === 'speed')?.axis).toBe('m/s');
    expect(signals.find((signal) => signal.key === 'actualMotor')?.axis).toBe('Command');
  });

  it('combines vehicle and PID samples by time, preserving missing data and pre-limit sums', () => {
    const samples = telemetrySamples({
      version: 1,
      vehicle: [{ time: 100, values: { speed: 30 } }, { time: 300, values: { speed: 32 } }],
      pids: { 'c:10': [{ time: 100, terms: { proportional: 2, integral: 0.5, derivative: 0.2, output: 1 } }, { time: 200, terms: {} }] },
    });
    expect(samples.map((sample) => sample.time)).toEqual([100, 200, 300]);
    expect(samples[0].values).toMatchObject({ speed: 30, 'pid:c:10:sum': 2.7, 'pid:c:10:output': 1 });
    expect(samples[1].values.speed).toBeUndefined();
    expect(samples[1].values['pid:c:10:sum']).toBeUndefined();
    expect(samples[2].values['pid:c:10:output']).toBeUndefined();
  });

  it('adds graph(...) series that share an axis per unit, or get their own without one', () => {
    const signals = telemetrySignals([], { gap: 'm', offset: 'm', braking: undefined });
    const graphs = signals.filter((signal) => signal.group === 'graph()');
    expect(graphs.map((signal) => [signal.key, signal.label, signal.axis])).toEqual([
      ['graph:gap', 'gap (m)', 'm'], ['graph:offset', 'offset (m)', 'm'], ['graph:braking', 'braking', 'braking'],
    ]);
  });
});
