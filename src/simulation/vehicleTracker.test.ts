import { describe, expect, it } from 'vitest';
import type { VehicleMeasurement } from '../types';
import { VehicleTracker } from './vehicleTracker';

describe('VehicleTracker', () => {
  it('initializes from the first measurement without blending stale state', () => {
    const tracker = new VehicleTracker();
    const observation = measurement(2.1, 42);
    const [track] = tracker.update([observation], 0.1);

    expect(track.relativeX).toBe(observation.relativeX);
    expect(track.relativeY).toBe(observation.relativeY);
    expect(track.relativeVx).toBe(0);
    expect(track.relativeVy).toBe(0);
    expect(track.isPredicted).toBe(false);
    expect(track.timeSinceMeasurement).toBe(0);
  });

  it('predicts through short dropouts, grows uncertainty, and then expires', () => {
    const tracker = new VehicleTracker({ maxPredictionTime: 0.42 });
    tracker.update([measurement(0, 40)], 0.1);
    const [updated] = tracker.update([measurement(0, 38.8)], 0.1);
    const [predicted] = tracker.update([], 0.1);

    expect(updated.relativeVy).toBeLessThan(0);
    expect(predicted.relativeY).toBeLessThan(updated.relativeY);
    expect(predicted.isPredicted).toBe(true);
    expect(predicted.timeSinceMeasurement).toBeCloseTo(0.1, 8);
    expect(predicted.confidence).toBeLessThan(updated.confidence);
    expect(predicted.uncertainty.longitudinalPosition).toBeGreaterThan(
      updated.uncertainty.longitudinalPosition,
    );

    tracker.update([], 0.1);
    tracker.update([], 0.1);
    tracker.update([], 0.1);
    expect(tracker.update([], 0.1)).toEqual([]);
  });
});

function measurement(relativeX: number, relativeY: number): VehicleMeasurement {
  return {
    id: 'vehicle-1',
    relativeX,
    relativeY,
    relativeHeading: 0.04,
    width: 2,
    length: 4.6,
    confidence: 0.9,
    uncertainty: {
      lateralPosition: 0.12,
      longitudinalPosition: 0.5,
      heading: 0.05,
    },
  };
}
