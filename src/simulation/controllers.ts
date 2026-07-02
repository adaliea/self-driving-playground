import type {
  AutopilotDebug,
  AutopilotInput,
  AutopilotOutput,
  LaneLineDetections,
  LaneLineSample,
  SanitizedAutopilotOutput,
  VehicleDetection,
} from '../types';
import { clamp, finiteOr } from './math';
import { DEFAULT_TRAFFIC_PERSONALITY } from './personalities';
import type { Road } from './road';
import type { VehicleState } from './vehicle';

export interface LaneAnalysis {
  centerOffset: number;
  heading: number;
  curvature: number;
  confidence: number;
}

export function sanitizeAutopilotOutput(
  rawOutput: unknown,
  fallbackTargetLane: number,
  laneCount: number,
): SanitizedAutopilotOutput {
  const invalidFields: string[] = [];
  const raw = isRecord(rawOutput) ? rawOutput : {};
  if (!isRecord(rawOutput)) invalidFields.push('output');

  const rawMotor = raw.motor;
  const rawSteering = raw.steering;
  const rawTargetLane = raw.targetLane;

  if (typeof rawMotor !== 'number' || !Number.isFinite(rawMotor)) invalidFields.push('motor');
  if (typeof rawSteering !== 'number' || !Number.isFinite(rawSteering)) invalidFields.push('steering');
  if (rawTargetLane !== undefined && (typeof rawTargetLane !== 'number' || !Number.isFinite(rawTargetLane))) {
    invalidFields.push('targetLane');
  }

  return {
    motor: clamp(finiteOr(rawMotor, 0), -1, 1),
    steering: clamp(finiteOr(rawSteering, 0), -1, 1),
    targetLane: clamp(Math.round(finiteOr(rawTargetLane, fallbackTargetLane)), 0, laneCount - 1),
    debug: sanitizeDebug(raw.debug),
    invalidFields,
  };
}

export function builtInLaneCentering(vehicle: VehicleState, road: Road, targetLane = vehicle.targetLane): number {
  const personality = vehicle.personality ?? DEFAULT_TRAFFIC_PERSONALITY;
  const desiredLateral = road.getLaneCenterOffset(targetLane);
  const rawLateralError = desiredLateral - vehicle.lateral;
  const isChangingLanes = targetLane !== vehicle.laneIndex;
  const lateralError = clamp(rawLateralError, isChangingLanes ? -1.45 : -2.15, isChangingLanes ? 1.45 : 2.15);
  const headingError = vehicle.headingOffset;
  const previewDistance = clamp(vehicle.speed * 0.85, 14, 34);
  const previewCurvature = road.sampleAt(vehicle.s + previewDistance).curvature;
  const steeringScale = clamp(vehicle.speed / 22, 0.08, 1);
  const curvatureFeedforward = (previewCurvature * vehicle.speed) / Math.max(0.08, 0.68 * steeringScale);
  return clamp(lateralError * personality.steeringGain - headingError * personality.headingGain + curvatureFeedforward, -1, 1);
}

export function builtInSpeedControl(input: AutopilotInput, desiredSpeed = 29): number {
  const closest = closestVehicleAhead(input.vehicles, input.targetLane);
  let targetSpeed = desiredSpeed;
  let gapBrake = 0;

  if (closest) {
    const frontSpeed = input.ego.speed + closest.relativeVy;
    const desiredGap = 12 + input.ego.speed * 1.55;
    const gapError = closest.relativeY - desiredGap;
    if (gapError < 24) {
      targetSpeed = Math.min(targetSpeed, Math.max(3, frontSpeed + gapError * 0.46));
    }
    if (gapError < 0) gapBrake = gapError * 0.12;
  }

  const speedError = targetSpeed - input.ego.speed;
  const feedforward = accelerationFeedforward(targetSpeed, input.ego.speed);
  return clamp(feedforward + speedError * 0.09 + gapBrake, -1, 1);
}

export function trafficAutopilot(vehicle: VehicleState, input: AutopilotInput, laneCount: number): AutopilotOutput {
  const personality = vehicle.personality ?? DEFAULT_TRAFFIC_PERSONALITY;
  const currentTarget = clamp(vehicle.targetLane, 0, laneCount - 1);
  let targetLane = currentTarget;
  const closest = closestVehicleAhead(input.vehicles, currentTarget);
  const stableForLaneChange =
    input.ego.laneIndex === currentTarget && Math.abs(vehicle.headingOffset) < 0.07 && Math.abs(vehicle.actualSteering) < 0.35;

  if (
    vehicle.laneChangeCooldown <= 0 &&
    stableForLaneChange &&
    closest &&
    closest.relativeY < personality.laneChangeLookahead &&
    closest.relativeVy < -personality.overtakeSpeedDelta
  ) {
    const candidates = [currentTarget - 1, currentTarget + 1].filter((lane) => lane >= 0 && lane < laneCount);
    const bestLane = candidates
      .map((lane) => ({ lane, score: laneClearanceScore(input.vehicles, lane, personality.minGap) }))
      .filter((candidate) => candidate.score > 18 + personality.minGap * (1.2 - personality.laneChangeEagerness))
      .sort((a, b) => b.score - a.score)[0];

    if (bestLane) {
      targetLane = bestLane.lane;
      vehicle.laneChangeCooldown = personality.laneChangeCooldown;
    }
  }

  const motor = trafficSpeedControl({ ...input, targetLane }, vehicle.desiredSpeed, personality);
  return {
    motor,
    steering: 0,
    targetLane,
  };
}

export function analyzeLaneDetections(laneLines: LaneLineDetections): LaneAnalysis {
  const left = representativeLinePoint(laneLines.left);
  const right = representativeLinePoint(laneLines.right);
  const fallbackConfidence = averageConfidence([...laneLines.left, ...laneLines.right]);

  if (!left && !right) {
    return {
      centerOffset: 0,
      heading: 0,
      curvature: 0,
      confidence: 0,
    };
  }

  const centerNear = lineCenterAtY(laneLines, 12);
  const centerMid = lineCenterAtY(laneLines, 34);
  const centerFar = lineCenterAtY(laneLines, 62);
  const centerOffset = centerNear.x;
  const heading = Math.atan2(centerFar.x - centerNear.x, Math.max(1, centerFar.y - centerNear.y));
  const curvature = ((centerFar.x - centerMid.x) - (centerMid.x - centerNear.x)) / 900;

  return {
    centerOffset,
    heading,
    curvature,
    confidence: clamp((centerNear.confidence + centerMid.confidence + centerFar.confidence) / 3 || fallbackConfidence, 0, 1),
  };
}

export function closestVehicleAhead(vehicles: VehicleDetection[], laneIndex: number): VehicleDetection | undefined {
  return vehicles
    .filter((vehicle) => vehicle.laneIndex === laneIndex && vehicle.relativeY > 0)
    .sort((a, b) => a.relativeY - b.relativeY)[0];
}

export function accelerationFeedforward(targetSpeed: number, currentSpeed: number): number {
  const speedError = targetSpeed - currentSpeed;
  const dragCompensation = 0.00048 * currentSpeed * currentSpeed + 0.004 * currentSpeed;
  const requestedAccel = speedError * 0.09 + dragCompensation;
  return clamp(requestedAccel, -1, 1);
}

function trafficSpeedControl(input: AutopilotInput, desiredSpeed: number, personality = DEFAULT_TRAFFIC_PERSONALITY): number {
  const closest = closestVehicleAhead(input.vehicles, input.targetLane);
  let targetSpeed = desiredSpeed;
  let gapBrake = 0;

  if (closest) {
    const frontSpeed = input.ego.speed + closest.relativeVy;
    const desiredGap = personality.minGap + input.ego.speed * personality.timeHeadway;
    const gapError = closest.relativeY - desiredGap;
    if (gapError < personality.laneChangeLookahead * 0.55) {
      targetSpeed = Math.min(targetSpeed, Math.max(3, frontSpeed + gapError * personality.gapGain));
    }
    if (gapError < 0) gapBrake = gapError * personality.brakeGain;
  }

  const speedError = targetSpeed - input.ego.speed;
  const feedforward = accelerationFeedforward(targetSpeed, input.ego.speed) * personality.feedforwardWeight;
  return clamp(feedforward + speedError * personality.speedGain + gapBrake, -1, 1);
}

function laneClearanceScore(vehicles: VehicleDetection[], laneIndex: number, minGap: number): number {
  let score = 80;
  for (const vehicle of vehicles) {
    if (vehicle.laneIndex !== laneIndex) continue;
    if (vehicle.relativeY > -minGap * 1.8 && vehicle.relativeY < minGap * 3.1) return -1;
    if (vehicle.relativeY > 0) score = Math.min(score, vehicle.relativeY);
  }
  return score;
}

function representativeLinePoint(samples: LaneLineSample[]): LaneLineSample | undefined {
  return samples
    .filter((sample) => sample.y > 8 && sample.y < 34)
    .sort((a, b) => Math.abs(a.y - 18) - Math.abs(b.y - 18))[0];
}

function lineCenterAtY(laneLines: LaneLineDetections, y: number): LaneLineSample {
  const left = sampleLineAtY(laneLines.left, y);
  const right = sampleLineAtY(laneLines.right, y);

  if (left && right) {
    return {
      x: (left.x + right.x) / 2,
      y,
      confidence: (left.confidence + right.confidence) / 2,
    };
  }

  if (left) {
    return { x: left.x + 1.85, y, confidence: left.confidence * 0.5 };
  }

  if (right) {
    return { x: right.x - 1.85, y, confidence: right.confidence * 0.5 };
  }

  return { x: 0, y, confidence: 0 };
}

function sampleLineAtY(samples: LaneLineSample[], y: number): LaneLineSample | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a.y - b.y);
  let before = sorted[0];
  let after = sorted[sorted.length - 1];

  for (const sample of sorted) {
    if (sample.y <= y) before = sample;
    if (sample.y >= y) {
      after = sample;
      break;
    }
  }

  if (before === after) return before;
  const t = (y - before.y) / Math.max(0.001, after.y - before.y);
  return {
    x: before.x + (after.x - before.x) * t,
    y,
    confidence: before.confidence + (after.confidence - before.confidence) * t,
  };
}

function averageConfidence(samples: LaneLineSample[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((total, sample) => total + sample.confidence, 0) / samples.length;
}

function sanitizeDebug(value: unknown): AutopilotDebug | undefined {
  if (!isRecord(value)) return undefined;
  const debug: AutopilotDebug = {};
  if (isRecord(value.lanePid)) debug.lanePid = sanitizePidTerms(value.lanePid);
  if (isRecord(value.speedPid)) debug.speedPid = sanitizePidTerms(value.speedPid);
  return debug.lanePid || debug.speedPid ? debug : undefined;
}

function sanitizePidTerms(value: Record<string, unknown>) {
  return {
    error: finiteOr(value.error, 0),
    proportional: finiteOr(value.proportional, 0),
    integral: finiteOr(value.integral, 0),
    derivative: finiteOr(value.derivative, 0),
    output: finiteOr(value.output, 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
