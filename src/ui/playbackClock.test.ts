import { describe, expect, it } from 'vitest';
import { PlaybackClock } from './playbackClock';

/** Feeds samples every `intervalMs` (sample time advancing in step) while ticking at 60 fps. */
function run(clock: PlaybackClock, durationMs: number, intervalMs = 110, startMs = 0) {
  const frames: number[] = [];
  let nextSample = startMs;
  for (let now = startMs; now <= startMs + durationMs; now += 1000 / 60) {
    while (nextSample <= now) {
      clock.push(nextSample / 1000, nextSample);
      nextSample += intervalMs;
    }
    frames.push(clock.tick(now, 1 / 60));
  }
  return frames;
}

describe('PlaybackClock', () => {
  it('advances every frame between 10 Hz samples without passing the newest one', () => {
    const clock = new PlaybackClock();
    const frames = run(clock, 3000).slice(60);
    const steps = frames.slice(1).map((value, index) => value - frames[index]);
    expect(Math.min(...steps)).toBeGreaterThan(0);
    // A 60 fps frame is ~16.7 ms; steps stay near that instead of 110 ms jumps.
    expect(Math.max(...steps)).toBeLessThan(0.03);
    expect(frames[frames.length - 1]).toBeLessThanOrEqual(3);
  });

  it('settles on the last sample once samples stop', () => {
    const clock = new PlaybackClock();
    run(clock, 2000);
    let now = 2000;
    for (let frame = 0; frame < 120; frame += 1) clock.tick((now += 1000 / 60), 1 / 60);
    expect(clock.settled(now)).toBe(true);
    expect(clock.current()).toBeCloseTo(1.98, 3);
  });

  it('jumps to the new time when history restarts', () => {
    const clock = new PlaybackClock();
    run(clock, 2000);
    clock.push(0.1, 2100);
    expect(clock.current()).toBe(0.1);
  });
});
