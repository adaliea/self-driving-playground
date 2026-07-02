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
const ROAD_TURN_SPACING = 240;

interface RoadTurnFeature {
  start: number;
  length: number;
  amplitude: number;
  followupAmplitude: number;
  followupOffset: number;
  followupLength: number;
}

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
      0.00105 + unitHash(seed, 51) * 0.00065,
      0.00048 + unitHash(seed, 67) * 0.00034,
      0.00026 + unitHash(seed, 83) * 0.0002,
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
    const localTurns = this.turnCurvatureAt(s);

    const easing = clamp(station / 160, 0, 1);
    return (lowFrequency + localTurns) * easing;
  }

  private turnCurvatureAt(station: number): number {
    const currentCell = Math.floor(station / ROAD_TURN_SPACING);
    let curvature = 0;

    for (let cell = Math.max(0, currentCell - 1); cell <= currentCell + 1; cell += 1) {
      const feature = this.turnFeatureForCell(cell);
      curvature += turnFeatureContribution(station, feature.start, feature.length, feature.amplitude);
      curvature += turnFeatureContribution(
        station,
        feature.start + feature.followupOffset,
        feature.followupLength,
        feature.followupAmplitude,
      );
    }

    return curvature;
  }

  private turnFeatureForCell(cell: number): RoadTurnFeature {
    const densityRoll = unitHash(this.seed, cell * 37 + 101);
    const isActive = densityRoll > 0.38;
    if (!isActive) {
      return {
        start: cell * ROAD_TURN_SPACING,
        length: 1,
        amplitude: 0,
        followupAmplitude: 0,
        followupOffset: 0,
        followupLength: 1,
      };
    }

    const sharpRoll = unitHash(this.seed, cell * 37 + 211);
    const isUltraSharp = sharpRoll > 0.985;
    const isVerySharp = sharpRoll > 0.9;
    const isSharp = sharpRoll > 0.82;
    const sign = unitHash(this.seed, cell * 37 + 307) > 0.5 ? 1 : -1;
    const start = cell * ROAD_TURN_SPACING + 35 + unitHash(this.seed, cell * 37 + 409) * 85;
    const normalLength = 135 + unitHash(this.seed, cell * 37 + 509) * 150;
    const sharpLength = 92 + unitHash(this.seed, cell * 37 + 503) * 68;
    const verySharpLength = 58 + unitHash(this.seed, cell * 37 + 499) * 52;
    const ultraSharpLength = 44 + unitHash(this.seed, cell * 37 + 491) * 34;
    const length = isUltraSharp ? ultraSharpLength : isVerySharp ? verySharpLength : isSharp ? sharpLength : normalLength;
    const normalAmplitude = 0.00125 + unitHash(this.seed, cell * 37 + 607) * 0.00225;
    const sharpAmplitude = 0.0038 + unitHash(this.seed, cell * 37 + 601) * 0.0027;
    const verySharpAmplitude = 0.009 + unitHash(this.seed, cell * 37 + 599) * 0.0045;
    const ultraSharpAmplitude = 0.013 + unitHash(this.seed, cell * 37 + 593) * 0.0048;
    const amplitude = sign * (isUltraSharp ? ultraSharpAmplitude : isVerySharp ? verySharpAmplitude : isSharp ? sharpAmplitude : normalAmplitude);
    const hasFollowup = unitHash(this.seed, cell * 37 + 701) > (isUltraSharp ? 0.3 : isVerySharp ? 0.36 : isSharp ? 0.42 : 0.58);
    const followupSign = unitHash(this.seed, cell * 37 + 809) > 0.45 ? -sign : sign;

    return {
      start,
      length,
      amplitude,
      followupAmplitude: hasFollowup ? followupSign * Math.abs(amplitude) * (0.45 + unitHash(this.seed, cell * 37 + 907) * 0.38) : 0,
      followupOffset: length * (0.68 + unitHash(this.seed, cell * 37 + 1009) * 0.42),
      followupLength: length * (0.55 + unitHash(this.seed, cell * 37 + 1103) * 0.45),
    };
  }
}

function turnFeatureContribution(station: number, start: number, length: number, amplitude: number): number {
  if (amplitude === 0 || station < start || station > start + length) return 0;
  const t = (station - start) / length;
  return amplitude * smoothPulse(t);
}

function smoothPulse(t: number): number {
  const edge = 0.24;
  if (t < edge) return smootherstep(t / edge);
  if (t > 1 - edge) return smootherstep((1 - t) / edge);
  return 1;
}

function smootherstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function unitHash(seed: number, salt: number): number {
  return hashSeed(seed, salt) / 0xffffffff;
}
