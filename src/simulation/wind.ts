import { SeededRandom, hashSeed } from './random';

const WIND_SEED_SALT = 0x57494e44;
const MIN_BIAS = 0.15;
const MAX_BIAS = 0.35;
const GUST_TAU = 2.5;
const GUST_STD = 0.1;

/**
 * Wind along the road, as a deceleration in m/s² (negative is a tailwind).
 *
 * Each run gets a steady headwind or tailwind, which a feedforward model of
 * drag can't know about, so speed controllers need an integral term to hold
 * speed. Gusts wander around it as a slow random walk that pulls back toward 0.
 * Wind has its own random stream so turning it on leaves traffic unchanged.
 */
export class Wind {
  private readonly rng: SeededRandom;
  private readonly bias: number;
  private gust = 0;

  constructor(seed: number) {
    this.rng = new SeededRandom(hashSeed(seed, WIND_SEED_SALT));
    const magnitude = this.rng.range(MIN_BIAS, MAX_BIAS);
    this.bias = this.rng.chance(0.7) ? magnitude : -magnitude;
  }

  /** Advances the gusts by dt and returns the current wind deceleration. */
  step(dt: number): number {
    const decay = Math.exp(-dt / GUST_TAU);
    this.gust = this.gust * decay + this.rng.gaussian(0, GUST_STD * Math.sqrt(1 - decay * decay));
    return this.bias + this.gust;
  }
}
