import { describe, expect, it } from 'vitest';
import { raceCameraTarget } from './raceCamera';

const options = { viewportWidth: 1000, minScale: 6.5, maxScale: 13, packWindowMeters: 120 };
/** Screen x of a road position, with the camera center in the middle of the viewport. */
const screenX = (s: number, target: { centerS: number; scale: number }) => options.viewportWidth / 2 + (s - target.centerS) * target.scale;

describe('race camera', () => {
  it('fits a close pack', () => {
    const target = raceCameraTarget([100, 110, 130], options)!;
    for (const s of [100, 110, 130]) {
      expect(screenX(s, target)).toBeGreaterThan(0);
      expect(screenX(s, target)).toBeLessThan(options.viewportWidth);
    }
  });

  it('keeps the leader on screen when the pack is too spread out to fit', () => {
    for (const viewportWidth of [500, 800, 1400]) {
      const wide = { ...options, viewportWidth };
      const target = raceCameraTarget([0, 60, 115, 400], wide)!;
      const x = wide.viewportWidth / 2 + (400 - target.centerS) * target.scale;
      expect(x).toBeLessThan(wide.viewportWidth - 100);
      expect(x).toBeGreaterThan(0);
    }
  });

  it('returns nothing with no cars', () => {
    expect(raceCameraTarget([], options)).toBeUndefined();
  });
});
