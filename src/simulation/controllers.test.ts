import { describe, expect, it } from 'vitest';
import type { AutopilotInput, LaneLineDetections, VehicleTrack } from '../types';
import { builtInAssistLaneKeeping, builtInAssistSpeedControl, closestVehicleAhead, isVehicleInLane } from './controllers';

function inputForCenter(center: (y: number) => number): AutopilotInput {
  const boundary = (offset: number) => Array.from({ length: 46 }, (_, i) => {
    const y = 3 + i * 2;
    return { x: center(y) + offset, y, confidence: 1 };
  });
  const laneLines: LaneLineDetections = {
    farLeft: boundary(-5.55), left: boundary(-1.85),
    right: boundary(1.85), farRight: boundary(5.55),
  };
  return {
    dt: 1 / 45, ego: { speed: 24, heading: 0, lateralVelocity: 0, yawRate: 0, laneIndex: 1 },
    vehicles: [], vehicleMeasurements: [], laneLines,
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

  it('corrects offsets toward the current lane center', () => {
    expect(builtInAssistLaneKeeping(inputForCenter(() => 0.5))).toBeGreaterThan(0);
    expect(builtInAssistLaneKeeping(inputForCenter(() => -0.5))).toBeLessThan(0);
  });

  it('keeps the heading fallback when no lane lines are visible', () => {
    const input = inputForCenter(() => 0);
    input.laneLines = { left: [], right: [], farLeft: [], farRight: [] };
    input.ego.heading = 0.2;
    expect(builtInAssistLaneKeeping(input)).toBeCloseTo(-0.22);
  });
});

describe('lane occupancy', () => {
  const vehicle = (relativeX: number, relativeY: number, relativeHeading = 0): VehicleTrack => ({
    id: `${relativeX},${relativeY}`, relativeX, relativeY, relativeHeading, width: 1.9, length: 4.6,
  } as VehicleTrack);

  it('counts a vehicle in every lane its bounding box overlaps', () => {
    const { laneLines } = inputForCenter(() => 0);
    const straddling = vehicle(1.85 + 0.95 - 0.1, 20);
    expect(isVehicleInLane(straddling, laneLines, 0)).toBe(true);
    expect(isVehicleInLane(straddling, laneLines, 1)).toBe(true);
    expect(isVehicleInLane(vehicle(1.85 + 0.95 + 0.1, 20), laneLines, 0)).toBe(false);
    expect(isVehicleInLane(vehicle(-3.7, 20), laneLines, -1)).toBe(true);
    expect(isVehicleInLane(vehicle(-3.7, 20), laneLines, 0)).toBe(false);
  });

  it('widens the footprint of a vehicle yawed across the lane', () => {
    const { laneLines } = inputForCenter(() => 0);
    // Center is 2.0 m right of our right line; sideways it reaches back over it.
    expect(isVehicleInLane(vehicle(3.85, 20, 0), laneLines, 0)).toBe(false);
    expect(isVehicleInLane(vehicle(3.85, 20, Math.PI / 2), laneLines, 0)).toBe(true);
  });

  it('measures lanes in their own frame on a curve ahead', () => {
    const curvature = 0.004;
    const { laneLines } = inputForCenter((y) => curvature * y * y);
    const y = 60;
    const heading = Math.atan(2 * curvature * y);
    const center = curvature * y * y;
    expect(isVehicleInLane(vehicle(center, y, heading), laneLines, 0)).toBe(true);
    expect(isVehicleInLane(vehicle(center + 3.7, y, heading), laneLines, 0)).toBe(false);
    expect(isVehicleInLane(vehicle(center + 3.7, y, heading), laneLines, 1)).toBe(true);
  });

  it('extends lane lines behind ego and falls back to a nominal lane without detections', () => {
    const { laneLines } = inputForCenter(() => 0);
    expect(isVehicleInLane(vehicle(0, -25), laneLines, 0)).toBe(true);
    expect(isVehicleInLane(vehicle(3.7, -25), laneLines, 1)).toBe(true);
    const none: LaneLineDetections = { left: [], right: [], farLeft: [], farRight: [] };
    expect(isVehicleInLane(vehicle(0.5, 20), none, 0)).toBe(true);
    expect(isVehicleInLane(vehicle(3.7, 20), none, 0)).toBe(false);
    expect(isVehicleInLane(vehicle(3.7, 20), none, 1)).toBe(true);
  });

  it('picks the nearest vehicle ahead in the requested lane', () => {
    const { laneLines } = inputForCenter(() => 0);
    const vehicles = [vehicle(0, -6), vehicle(3.7, 8), vehicle(0.4, 30), vehicle(-0.3, 15)];
    expect(closestVehicleAhead(vehicles, laneLines)?.id).toBe('-0.3,15');
    expect(closestVehicleAhead(vehicles, laneLines, 1)?.id).toBe('3.7,8');
    expect(closestVehicleAhead(vehicles, laneLines, -1)).toBeUndefined();
  });
});
