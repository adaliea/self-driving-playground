import { describe, expect, it } from 'vitest';
import type { AutopilotInput, LaneLineDetections } from '../types';
import { builtInAssistLaneKeeping, builtInAssistSpeedControl } from './controllers';

function inputForCenter(center: (y: number) => number, targetLane = 1): AutopilotInput {
  const boundary = (offset: number) => Array.from({ length: 46 }, (_, i) => {
    const y = 3 + i * 2;
    return { x: center(y) + offset, y, confidence: 1 };
  });
  const laneLines: LaneLineDetections = {
    farLeft: boundary(-5.55), left: boundary(-1.85),
    right: boundary(1.85), farRight: boundary(5.55),
  };
  return {
    dt: 1 / 45, ego: { speed: 24, heading: 0, laneIndex: 1 },
    vehicles: [], vehicleMeasurements: [], laneLines, targetLane,
  };
}

describe('assisted corner timing', () => {
  it.each([-1, 1])('waits for a distant corner before steering (direction %s)', (direction) => {
    const input = inputForCenter((y) => direction * 0.01 * Math.max(0, y - 24) ** 2);
    expect(Math.abs(builtInAssistLaneKeeping(input))).toBeLessThan(0.005);
    // A distant bend must still be visible to speed planning.
    expect(builtInAssistSpeedControl(input)).toBeLessThan(builtInAssistSpeedControl(inputForCenter(() => 0)));
  });

  it.each([-1, 1])('holds steering while a corner exit is still ahead (direction %s)', (direction) => {
    const continuing = inputForCenter((y) => direction * 0.01 * y * y);
    const ending = inputForCenter((y) => direction * 0.01 * (y * y - Math.max(0, y - 24) ** 2));
    expect(builtInAssistLaneKeeping(ending)).toBeCloseTo(builtInAssistLaneKeeping(continuing), 6);
    expect(direction * builtInAssistLaneKeeping(ending)).toBeGreaterThan(0.3);
  });

  it('corrects offsets and selects adjacent target lanes', () => {
    expect(builtInAssistLaneKeeping(inputForCenter(() => 0.5))).toBeGreaterThan(0);
    expect(builtInAssistLaneKeeping(inputForCenter(() => -0.5))).toBeLessThan(0);
    expect(builtInAssistLaneKeeping(inputForCenter(() => 0, 0))).toBeLessThan(0);
    expect(builtInAssistLaneKeeping(inputForCenter(() => 0, 2))).toBeGreaterThan(0);
  });

  it('keeps the heading fallback when no lane lines are visible', () => {
    const input = inputForCenter(() => 0);
    input.laneLines = { left: [], right: [], farLeft: [], farRight: [] };
    input.ego.heading = 0.2;
    expect(builtInAssistLaneKeeping(input)).toBeCloseTo(-0.22);
  });
});
