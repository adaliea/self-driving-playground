import { clamp, lerp } from './math';
import { hashSeed } from './random';

export interface RoadSample {
  s: number;
  x: number;
  y: number;
  heading: number;
  curvature: number;
}

export interface RoadPoint extends RoadSample {
  lateral: number;
}

export const ROAD_LANE_COUNT = 3;
export const ROAD_LANE_WIDTH = 3.7;

const ROAD_SAMPLE_SPACING = 4;

export class Road {
  readonly laneCount = ROAD_LANE_COUNT;
  readonly laneWidth = ROAD_LANE_WIDTH;
  readonly sampleSpacing = ROAD_SAMPLE_SPACING;

  private readonly samples: RoadSample[] = [
    {
      s: 0,
      x: 0,
      y: 0,
      heading: 0,
      curvature: 0,
    },
  ];

  private readonly phases: number[];
  private readonly amplitudes: number[];

  constructor(readonly seed: number, initialLength = 1800) {
    this.phases = [
      (hashSeed(seed, 11) / 0xffffffff) * Math.PI * 2,
      (hashSeed(seed, 23) / 0xffffffff) * Math.PI * 2,
      (hashSeed(seed, 37) / 0xffffffff) * Math.PI * 2,
    ];
    this.amplitudes = [
      0.0008 + (hashSeed(seed, 51) / 0xffffffff) * 0.00045,
      0.00035 + (hashSeed(seed, 67) / 0xffffffff) * 0.00025,
      0.0002 + (hashSeed(seed, 83) / 0xffffffff) * 0.00015,
    ];
    this.extendTo(initialLength);
  }

  get length(): number {
    return this.samples[this.samples.length - 1].s;
  }

  extendTo(targetStation: number): void {
    while (this.length < targetStation) {
      const previous = this.samples[this.samples.length - 1];
      const nextS = previous.s + this.sampleSpacing;
      const curvature = this.curvatureAt(previous.s);
      const heading = previous.heading + curvature * this.sampleSpacing;
      this.samples.push({
        s: nextS,
        x: previous.x + Math.sin(heading) * this.sampleSpacing,
        y: previous.y + Math.cos(heading) * this.sampleSpacing,
        heading,
        curvature: this.curvatureAt(nextS),
      });
    }
  }

  sampleAt(station: number): RoadSample {
    const s = clamp(station, 0, this.length);
    const rawIndex = s / this.sampleSpacing;
    const index = Math.floor(rawIndex);
    const nextIndex = Math.min(index + 1, this.samples.length - 1);
    const a = this.samples[index];
    const b = this.samples[nextIndex];
    const t = a.s === b.s ? 0 : (s - a.s) / (b.s - a.s);

    return {
      s,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      heading: lerp(a.heading, b.heading, t),
      curvature: lerp(a.curvature, b.curvature, t),
    };
  }

  worldPointAt(station: number, lateral: number): RoadPoint {
    const sample = this.sampleAt(station);
    const rightX = Math.cos(sample.heading);
    const rightY = -Math.sin(sample.heading);

    return {
      ...sample,
      lateral,
      x: sample.x + rightX * lateral,
      y: sample.y + rightY * lateral,
    };
  }

  getLaneCenterOffset(laneIndex: number): number {
    const clamped = clamp(Math.round(laneIndex), 0, this.laneCount - 1);
    return (clamped - (this.laneCount - 1) / 2) * this.laneWidth;
  }

  getBoundaryOffset(boundaryIndex: number): number {
    const clamped = clamp(Math.round(boundaryIndex), 0, this.laneCount);
    return (clamped - this.laneCount / 2) * this.laneWidth;
  }

  getLaneIndex(lateral: number): number {
    return clamp(Math.round(lateral / this.laneWidth + (this.laneCount - 1) / 2), 0, this.laneCount - 1);
  }

  getRoadHalfWidth(): number {
    return (this.laneCount * this.laneWidth) / 2;
  }

  sampleLine(boundaryIndex: number, startS: number, endS: number, spacing = 6): RoadPoint[] {
    const points: RoadPoint[] = [];
    const offset = this.getBoundaryOffset(boundaryIndex);
    for (let s = startS; s <= endS; s += spacing) {
      this.extendTo(s + 20);
      points.push(this.worldPointAt(s, offset));
    }
    return points;
  }

  private curvatureAt(station: number): number {
    const s = station;
    const lowFrequency =
      Math.sin(s * 0.0042 + this.phases[0]) * this.amplitudes[0] +
      Math.sin(s * 0.009 + this.phases[1]) * this.amplitudes[1] +
      Math.sin(s * 0.017 + this.phases[2]) * this.amplitudes[2];

    const easing = clamp(station / 120, 0, 1);
    return lowFrequency * easing;
  }
}
