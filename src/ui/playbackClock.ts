/**
 * Turns sample times that arrive in bursts (about 10 Hz) into a smoothly advancing playback time,
 * so a scrolling chart can move every animation frame instead of jumping on each update.
 *
 * Playback runs a little behind the newest sample, so the newest line segment is already drawn
 * when the window reaches it. When samples stop arriving (paused or held), playback catches up
 * to the last sample and settles there.
 */
export class PlaybackClock {
  private display?: number;
  private latest = 0;
  private lastArrival?: number;
  /** Simulation seconds per wall-clock second, estimated from arrivals. */
  private rate = 1;

  constructor(
    /** Seconds playback stays behind the newest sample while data is flowing. */
    private readonly delay = 0.15,
    /** Wall-clock milliseconds without new samples before playback treats the data as stopped. */
    private readonly staleAfterMs = 400,
  ) {}

  /** Records the newest sample time (seconds) observed at wall-clock time `now` (ms). */
  push(latest: number, now: number): void {
    if (this.display === undefined || latest < this.latest) {
      // First sample, or the history restarted: jump straight there.
      this.display = latest;
    } else if (latest > this.latest && this.lastArrival !== undefined) {
      const elapsedMs = now - this.lastArrival;
      if (elapsedMs > 0 && elapsedMs < this.staleAfterMs) {
        const measured = (latest - this.latest) / (elapsedMs / 1000);
        this.rate += (measured - this.rate) * 0.3;
      }
    }
    if (latest !== this.latest || this.lastArrival === undefined) this.lastArrival = now;
    this.latest = latest;
  }

  /** Advances playback by `dtSeconds` of wall-clock time and returns the playback time (seconds). */
  tick(now: number, dtSeconds: number): number {
    if (this.display === undefined) return this.latest;
    const flowing = this.isFlowing(now);
    const target = flowing ? this.latest - this.delay : this.latest;
    const advance = flowing ? dtSeconds * this.rate : 0;
    // Advance at the measured rate, and correct gently toward the target to absorb arrival jitter.
    const corrected = this.display + advance + (target - this.display) * Math.min(1, dtSeconds * 4);
    this.display = Math.min(this.latest, corrected);
    return this.display;
  }

  /** Current playback time (seconds) without advancing it. */
  current(): number {
    return this.display ?? this.latest;
  }

  /** True once samples have stopped and playback has caught up, so animation can stop. */
  settled(now: number): boolean {
    return !this.isFlowing(now) && this.latest - this.current() < 1e-4;
  }

  private isFlowing(now: number): boolean {
    return this.lastArrival !== undefined && now - this.lastArrival < this.staleAfterMs;
  }
}
