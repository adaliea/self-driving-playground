import type { AutopilotInput, LaneLineDetections, LaneLineSample, PlaygroundSettings, VehicleDetection } from '../types';
import { clamp } from './math';
import type { Road } from './road';
import type { SeededRandom } from './random';
import type { VehicleState } from './vehicle';

export interface SensorNoiseOptions {
  noisyLaneLines: boolean;
  noisyVehicles: boolean;
}

export class SensorSimulator {
  private readonly laggedDetections = new Map<string, Map<string, VehicleDetection>>();

  reset(): void {
    this.laggedDetections.clear();
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
      vehicles: this.detectVehicles(subject, vehicles, road, settings.noisyVehicles, rng),
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
      vehicles: this.detectVehicles(subject, vehicles, road, false, rng),
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

      if (relativeY < -42 || relativeY > 135 || Math.abs(relativeX) > 20) continue;
      if (noisy && rng.chance(0.035)) continue;

      const detection: VehicleDetection = {
        id: vehicle.id,
        relativeX: relativeX + (noisy ? rng.range(-0.38, 0.38) : 0),
        relativeY: relativeY + (noisy ? rng.range(-1.1, 1.1) : 0),
        relativeVx: noisy ? rng.range(-0.24, 0.24) : 0,
        relativeVy: vehicle.speed - subject.speed + (noisy ? rng.range(-0.45, 0.45) : 0),
        width: Math.max(1.4, vehicle.width + (noisy ? rng.range(-0.16, 0.16) : 0)),
        length: Math.max(3.4, vehicle.length + (noisy ? rng.range(-0.32, 0.32) : 0)),
        confidence: noisy ? rng.range(0.72, 0.98) : 1,
        laneIndex: road.getLaneIndex(vehicle.lateral + (noisy ? rng.range(-0.18, 0.18) : 0)),
      };

      detections.push(noisy ? this.smoothDetection(subject.id, detection) : detection);
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

    for (let ahead = 4; ahead <= 92; ahead += 5.5) {
      if (noisy && rng.chance(0.11 + ahead / 1200)) continue;
      const worldPoint = road.worldPointAt(subject.s + ahead, road.getBoundaryOffset(boundaryIndex));
      const dx = worldPoint.x - subjectPose.x;
      const dy = worldPoint.y - subjectPose.y;
      samples.push({
        x: dx * right.x + dy * right.y + (noisy ? rng.range(-0.17, 0.17) : 0),
        y: dx * forward.x + dy * forward.y + (noisy ? rng.range(-0.26, 0.26) : 0),
        confidence: noisy ? clamp(rng.range(0.68, 0.98) - ahead / 280, 0.25, 1) : 1,
      });
    }

    return samples;
  }

  private smoothDetection(subjectId: string, detection: VehicleDetection): VehicleDetection {
    const map = this.getSubjectMap(subjectId);
    const previous = map.get(detection.id);
    if (!previous) {
      map.set(detection.id, detection);
      return detection;
    }

    const alpha = 0.42;
    const smoothed: VehicleDetection = {
      ...detection,
      relativeX: previous.relativeX + (detection.relativeX - previous.relativeX) * alpha,
      relativeY: previous.relativeY + (detection.relativeY - previous.relativeY) * alpha,
      relativeVx: previous.relativeVx + (detection.relativeVx - previous.relativeVx) * alpha,
      relativeVy: previous.relativeVy + (detection.relativeVy - previous.relativeVy) * alpha,
      width: previous.width + (detection.width - previous.width) * alpha,
      length: previous.length + (detection.length - previous.length) * alpha,
    };
    map.set(detection.id, smoothed);
    return smoothed;
  }

  private getSubjectMap(subjectId: string): Map<string, VehicleDetection> {
    const existing = this.laggedDetections.get(subjectId);
    if (existing) return existing;
    const next = new Map<string, VehicleDetection>();
    this.laggedDetections.set(subjectId, next);
    return next;
  }
}
