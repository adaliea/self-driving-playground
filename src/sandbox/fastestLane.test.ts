import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { laneSelectionImplementation, vehicleFilteringImplementation } from '../toolbox/library';
import type { AutopilotInput, LaneLineDetections, VehicleTrack } from '../types';

interface LaneChooserOptions {
  minSpeedGain?: number;
  lookahead?: number;
  openLaneSpeed?: number;
  minFrontGap?: number;
  minRearGap?: number;
  cooldown?: number;
  laneCount?: number;
}
interface LaneChooser {
  update(input: AutopilotInput): number;
  reset(): void;
}

// Execute the helper source shipped to user code.
const toolbox = ts.transpileModule(vehicleFilteringImplementation + laneSelectionImplementation, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const createLaneChooser = new Function(`${toolbox}\nreturn createLaneChooser;`)() as (
  options?: LaneChooserOptions,
) => LaneChooser;

const boundary = (offset: number) => Array.from({ length: 46 }, (_, i) => ({ x: offset, y: 3 + 2 * i, confidence: 1 }));
const laneLines: LaneLineDetections = {
  farLeft: boundary(-5.55), left: boundary(-1.85), right: boundary(1.85), farRight: boundary(5.55),
};

/** A vehicle in lane relativeLane, relativeY ahead, moving at the given absolute speed. */
const car = (relativeLane: number, relativeY: number, speed: number): VehicleTrack => ({
  id: `${relativeLane}:${relativeY}`, relativeX: relativeLane * 3.7, relativeY, relativeVy: speed - 25,
  relativeVx: 0, relativeHeading: 0, width: 1.9, length: 4.6,
} as VehicleTrack);

function input(vehicles: VehicleTrack[], laneIndex = 1): AutopilotInput {
  return {
    dt: 1 / 45, ego: { speed: 25, heading: 0, lateralVelocity: 0, yawRate: 0, laneIndex },
    vehicles, vehicleMeasurements: [], laneLines,
  };
}

/** Relative lane chosen by a fresh chooser on one snapshot. */
const choose = (snapshot: AutopilotInput, options?: LaneChooserOptions) => createLaneChooser(options).update(snapshot);

describe('createLaneChooser', () => {
  it('moves to a faster adjacent lane only when the gain meets the minimum', () => {
    const traffic = [car(0, 30, 20), car(-1, 40, 21), car(1, 40, 23)];
    expect(choose(input(traffic), { minSpeedGain: 2 })).toBe(1);
    expect(choose(input(traffic), { minSpeedGain: 4 })).toBe(0);
  });

  it('prefers the fastest candidate and treats an open lane as moving at openLaneSpeed', () => {
    expect(choose(input([car(0, 30, 18), car(-1, 40, 22), car(1, 40, 26)]))).toBe(1);
    expect(choose(input([car(0, 30, 18), car(-1, 40, 22)]))).toBe(1);
    expect(choose(input([car(0, 30, 18), car(1, 40, 22)]))).toBe(-1);
    // An open lane at the assumed 50 m/s is 24 m/s faster than a 26 m/s lead.
    expect(choose(input([car(0, 30, 26), car(-1, 30, 26)]), { minSpeedGain: 20 })).toBe(1);
    expect(choose(input([car(0, 30, 26), car(-1, 30, 26)]), { minSpeedGain: 25 })).toBe(0);
    expect(choose(input([car(0, 30, 26), car(-1, 30, 26)]), { minSpeedGain: 4, openLaneSpeed: 29 })).toBe(0);
  });

  it('stays put when the current lane is open or the lead is beyond the lookahead', () => {
    expect(choose(input([car(-1, 40, 30)]))).toBe(0);
    expect(choose(input([car(0, 80, 15)]), { lookahead: 60 })).toBe(0);
  });

  it('waits for room to merge', () => {
    // Left lane is blocked by equally slow traffic; right lane is open ahead.
    const slow = [car(0, 30, 18), car(-1, 30, 18)];
    expect(choose(input([...slow, car(1, 5, 30)]))).toBe(0);
    // 12 m behind but closing at 5 m/s needs 10 + 7.5 m.
    expect(choose(input([...slow, car(1, -12, 30)]))).toBe(0);
    expect(choose(input([...slow, car(1, -20, 30)]))).toBe(1);
  });

  it('respects road edges', () => {
    expect(choose(input([car(0, 30, 18)], 0))).toBe(1);
    expect(choose(input([car(0, 30, 18)], 2), { laneCount: 3 })).toBe(-1);
  });

  it('holds a lane change even after the reason for it disappears', () => {
    const chooser = createLaneChooser();
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18)]))).toBe(-1);
    // The slow lead sped up: a fresh decision would stay, but the change continues.
    expect(chooser.update(input([car(0, 30, 30), car(1, 30, 18)]))).toBe(-1);
  });

  it('settles in the new lane and waits out the cooldown before choosing again', () => {
    const chooser = createLaneChooser({ cooldown: 3 });
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18)]))).toBe(-1);
    // Ego crossed into lane 0; the old lane now looks faster, but the cooldown holds it.
    const arrived = input([car(0, 30, 18), car(1, 30, 30)], 0);
    expect(chooser.update(arrived)).toBe(0);
    for (let t = 0; t < 2.9; t += arrived.dt) expect(chooser.update(arrived)).toBe(0);
    for (let t = 0; t < 0.2; t += arrived.dt) chooser.update(arrived);
    expect(chooser.update(arrived)).toBe(1);
  });

  it('abandons a lane change when the target lane loses its room, then cools down', () => {
    const chooser = createLaneChooser({ cooldown: 3 });
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18)]))).toBe(-1);
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18), car(-1, 4, 25)]))).toBe(0);
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18)]))).toBe(0);
    chooser.reset();
    expect(chooser.update(input([car(0, 30, 18), car(1, 30, 18)]))).toBe(-1);
  });
});
