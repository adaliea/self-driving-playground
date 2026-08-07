import type { AutopilotInput, LaneLineDetections, LaneLineSample, PlaygroundSettings, VehicleDetection } from '../types';
import { clamp, normalizeAngle } from './math';
import type { Road } from './road';
import type { SeededRandom } from './random';
import type { VehicleState } from './vehicle';

export interface SensorNoiseOptions {
  noisyLaneLines: boolean;
  noisyVehicles: boolean;
}

interface DetectionError {
  relativeX: number;
  relativeY: number;
  relativeVx: number;
  relativeVy: number;
  relativeHeading: number;
  width: number;
  length: number;
}

interface DetectionNoiseScale extends DetectionError {
  outlierProbability: number;
}

interface DetectionTrack {
  error: DetectionError;
  filtered: VehicleDetection;
}

export class SensorSimulator {
  private readonly detectionTracks = new Map<string, Map<string, DetectionTrack>>();

  reset(): void {
    this.detectionTracks.clear();
  }

  createInput(
    subject: VehicleState,
    vehicles: VehicleState[],
    road: Road,
    settings: SensorNoiseOptions | PlaygroundSettings,
    rng: SeededRandom,
    dt: number,
  ): AutopilotInput {
    road.extendTo(subject.s + 180);
    const laneIndex = road.getLaneIndex(subject.lateral);
    const ego = {
      speed: subject.speed,
      heading: subject.headingOffset,
      laneIndex,
    };

    return {
      dt,
      ego,
      vehicles: this.detectVehicles(subject, vehicles, road, settings.noisyVehicles, rng, dt),
      laneLines: this.detectLaneLines(subject, road, settings.noisyLaneLines, rng),
      targetLane: clamp(subject.targetLane, 0, road.laneCount - 1),
    };
  }

  createTrafficInput(
    subject: VehicleState,
    vehicles: VehicleState[],
    road: Road,
    rng: SeededRandom,
    dt: number,
  ): AutopilotInput {
    const laneIndex = road.getLaneIndex(subject.lateral);

    return {
      dt,
      ego: {
        speed: subject.speed,
        heading: subject.headingOffset,
        laneIndex,
      },
      vehicles: this.detectVehicles(subject, vehicles, road, false, rng, dt),
      laneLines: {
        left: [],
        right: [],
        farLeft: [],
        farRight: [],
      },
      targetLane: clamp(subject.targetLane, 0, road.laneCount - 1),
    };
  }

  private detectVehicles(
    subject: VehicleState,
    vehicles: VehicleState[],
    road: Road,
    noisy: boolean,
    rng: SeededRandom,
    dt: number,
  ): VehicleDetection[] {
    const subjectPose = road.worldPointAt(subject.s, subject.lateral);
    const subjectHeading = subjectPose.heading + subject.headingOffset;
    const forward = { x: Math.sin(subjectHeading), y: Math.cos(subjectHeading) };
    const right = { x: Math.cos(subjectHeading), y: -Math.sin(subjectHeading) };
    const detections: VehicleDetection[] = [];

    for (const vehicle of vehicles) {
      if (vehicle.id === subject.id) continue;
      const pose = road.worldPointAt(vehicle.s, vehicle.lateral);
      const dx = pose.x - subjectPose.x;
      const dy = pose.y - subjectPose.y;
      const relativeX = dx * right.x + dy * right.y;
      const relativeY = dx * forward.x + dy * forward.y;
      const vehicleHeading = pose.heading + vehicle.headingOffset;
      const relativeHeading = normalizeAngle(vehicleHeading - subjectHeading);

      if (relativeY < -42 || relativeY > 135 || Math.abs(relativeX) > 20) continue;
      const forwardDistance = Math.max(0, relativeY);
      const range = Math.hypot(relativeX, relativeY);
      const distanceT = clamp(forwardDistance / 135, 0, 1);
      const lateralT = clamp(Math.abs(relativeX) / 20, 0, 1);
      const quality = clamp(1 - distanceT * 0.7 - lateralT * 0.15, 0.2, 1);
      const missProbability = 0.003 + distanceT ** 2 * 0.055 + lateralT * 0.025;
      if (noisy && rng.chance(missProbability)) continue;

      const truth: VehicleDetection = {
        id: vehicle.id,
        relativeX,
        relativeY,
        relativeVx: vehicle.speed * Math.sin(relativeHeading),
        relativeVy: vehicle.speed * Math.cos(relativeHeading) - subject.speed,
        relativeHeading,
        width: vehicle.width,
        length: vehicle.length,
        confidence: 1,
        laneIndex: road.getLaneIndex(vehicle.lateral),
      };

      detections.push(noisy ? this.applyVehicleNoise(subject.id, truth, vehicle.lateral, range, quality, lateralT, road, rng, dt) : truth);
    }

    return detections.sort((a, b) => a.relativeY - b.relativeY);
  }

  private detectLaneLines(subject: VehicleState, road: Road, noisy: boolean, rng: SeededRandom): LaneLineDetections {
    const laneIndex = road.getLaneIndex(subject.lateral);
    const leftBoundary = laneIndex;
    const rightBoundary = laneIndex + 1;

    return {
      left: this.sampleBoundary(subject, road, leftBoundary, noisy, rng),
      right: this.sampleBoundary(subject, road, rightBoundary, noisy, rng),
      farLeft: this.sampleBoundary(subject, road, Math.max(0, leftBoundary - 1), noisy, rng),
      farRight: this.sampleBoundary(subject, road, Math.min(road.laneCount, rightBoundary + 1), noisy, rng),
    };
  }

  private sampleBoundary(
    subject: VehicleState,
    road: Road,
    boundaryIndex: number,
    noisy: boolean,
    rng: SeededRandom,
  ): LaneLineSample[] {
    const subjectPose = road.worldPointAt(subject.s, subject.lateral);
    const subjectHeading = subjectPose.heading + subject.headingOffset;
    const forward = { x: Math.sin(subjectHeading), y: Math.cos(subjectHeading) };
    const right = { x: Math.cos(subjectHeading), y: -Math.sin(subjectHeading) };
    const samples: LaneLineSample[] = [];

    for (const ahead of laneSampleDistances()) {
      const distanceT = clamp(ahead / 92, 0, 1);
      const quality = clamp(1 - distanceT * 0.72, 0.24, 1);
      if (noisy && rng.chance(0.025 + (1 - quality) * 0.2)) continue;
      const worldPoint = road.worldPointAt(subject.s + ahead, road.getBoundaryOffset(boundaryIndex));
      const dx = worldPoint.x - subjectPose.x;
      const dy = worldPoint.y - subjectPose.y;
      const xJitter = noisy ? 0.025 + distanceT * 0.22 : 0;
      const yJitter = noisy ? 0.04 + distanceT * 0.32 : 0;
      samples.push({
        x: dx * right.x + dy * right.y + (noisy ? rng.range(-xJitter, xJitter) : 0),
        y: dx * forward.x + dy * forward.y + (noisy ? rng.range(-yJitter, yJitter) : 0),
        confidence: noisy ? clamp(quality + rng.range(-0.06, 0.03), 0.24, 0.99) : 1,
      });
    }

    return samples;
  }

  private applyVehicleNoise(
    subjectId: string,
    truth: VehicleDetection,
    vehicleLateral: number,
    range: number,
    quality: number,
    lateralT: number,
    road: Road,
    rng: SeededRandom,
    dt: number,
  ): VehicleDetection {
    const map = this.getSubjectMap(subjectId);
    const previous = map.get(truth.id);
    const scale = detectionNoiseScale(range, lateralT);
    const correlation = Math.exp(-Math.max(dt, 0) / 0.48);
    const innovation = Math.sqrt(Math.max(0, 1 - correlation ** 2));
    const outlierScale = rng.chance(scale.outlierProbability) ? rng.range(2.2, 3.8) : 1;
    const nextError = evolveDetectionError(previous?.error, scale, correlation, innovation * outlierScale, rng);
    const raw: VehicleDetection = {
      ...truth,
      relativeX: truth.relativeX + nextError.relativeX,
      relativeY: truth.relativeY + nextError.relativeY,
      relativeVx: truth.relativeVx + nextError.relativeVx,
      relativeVy: truth.relativeVy + nextError.relativeVy,
      relativeHeading: normalizeAngle(truth.relativeHeading + nextError.relativeHeading),
      width: Math.max(1.4, truth.width + nextError.width),
      length: Math.max(3.4, truth.length + nextError.length),
      confidence: clamp(quality - (outlierScale > 1 ? 0.16 : 0) + rng.gaussian(0, 0.025), 0.25, 0.99),
      laneIndex: road.getLaneIndex(vehicleLateral + nextError.relativeX * 0.55),
    };

    const filtered = previous ? filterDetection(previous.filtered, raw, dt) : raw;
    map.set(truth.id, { error: nextError, filtered });
    return filtered;
  }

  private getSubjectMap(subjectId: string): Map<string, DetectionTrack> {
    const existing = this.detectionTracks.get(subjectId);
    if (existing) return existing;
    const next = new Map<string, DetectionTrack>();
    this.detectionTracks.set(subjectId, next);
    return next;
  }
}

function detectionNoiseScale(range: number, lateralT: number): DetectionNoiseScale {
  const distance = clamp(range, 0, 145);
  return {
    // Camera geometry constrains image-plane/lateral position better than depth.
    relativeX: 0.035 + distance * 0.0022 + distance ** 2 * 0.000018 + lateralT * 0.08,
    relativeY: 0.08 + distance * 0.006 + distance ** 2 * 0.000095,
    relativeVx: 0.08 + distance * 0.003,
    relativeVy: 0.12 + distance * 0.005,
    relativeHeading: degreesToRadians(1 + distance * 0.04 + distance ** 2 * 0.00025 + lateralT * 2),
    width: 0.03 + distance * 0.00065,
    length: 0.06 + distance * 0.0018,
    outlierProbability: 0.004 + (distance / 145) ** 2 * 0.016,
  };
}

function evolveDetectionError(
  previous: DetectionError | undefined,
  scale: DetectionNoiseScale,
  correlation: number,
  innovation: number,
  rng: SeededRandom,
): DetectionError {
  const evolve = (key: keyof DetectionError): number => {
    if (!previous) return rng.gaussian(0, scale[key]);
    return previous[key] * correlation + rng.gaussian(0, scale[key] * innovation);
  };
  return {
    relativeX: evolve('relativeX'),
    relativeY: evolve('relativeY'),
    relativeVx: evolve('relativeVx'),
    relativeVy: evolve('relativeVy'),
    relativeHeading: evolve('relativeHeading'),
    width: evolve('width'),
    length: evolve('length'),
  };
}

function filterDetection(previous: VehicleDetection, next: VehicleDetection, dt: number): VehicleDetection {
  const alpha = 1 - Math.exp(-Math.max(dt, 0) / 0.11);
  return {
    ...next,
    relativeX: previous.relativeX + (next.relativeX - previous.relativeX) * alpha,
    relativeY: previous.relativeY + (next.relativeY - previous.relativeY) * alpha,
    relativeVx: previous.relativeVx + (next.relativeVx - previous.relativeVx) * alpha,
    relativeVy: previous.relativeVy + (next.relativeVy - previous.relativeVy) * alpha,
    relativeHeading: normalizeAngle(
      previous.relativeHeading + normalizeAngle(next.relativeHeading - previous.relativeHeading) * alpha,
    ),
    width: previous.width + (next.width - previous.width) * alpha,
    length: previous.length + (next.length - previous.length) * alpha,
  };
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function laneSampleDistances(): number[] {
  const samples: number[] = [];
  for (let ahead = 3; ahead <= 92; ) {
    samples.push(ahead);
    ahead += ahead < 24 ? 2.4 : ahead < 54 ? 4.2 : 6.6;
  }
  return samples;
}
