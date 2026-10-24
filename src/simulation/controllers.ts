import type {
  AutopilotDebug,
  AutopilotInput,
  AutopilotOutput,
  LaneLineDetections,
  LaneLineSample,
  SanitizedAutopilotOutput,
  VehicleTrack,
} from '../types';
import { clamp, finiteOr } from './math';
import { DEFAULT_TRAFFIC_PERSONALITY } from './personalities';
import { ROAD_LANE_WIDTH, type Road } from './road';
import type { VehicleState } from './vehicle';

const ASSIST_EGO_HALF_WIDTH = 1.025;
const LANE_BODY_RECOVERY_MARGIN = 0.12;

export interface LaneAnalysis {
  centerOffset: number;
  heading: number;
  curvature: number;
  confidence: number;
}

interface LaneCenterFit {
  c0: number;
  c1: number;
  c2: number;
  confidence: number;
}

/** Sensor snapshot for traffic, which unlike players steers toward a declared lane. */
export interface TrafficAutopilotInput extends AutopilotInput {
  targetLane: number;
}

export interface TrafficAutopilotOutput extends AutopilotOutput {
  targetLane: number;
}

export function sanitizeAutopilotOutput(rawOutput: unknown): SanitizedAutopilotOutput {
  const invalidFields: string[] = [];
  const raw = isRecord(rawOutput) ? rawOutput : {};
  if (!isRecord(rawOutput)) invalidFields.push('output');

  const rawMotor = raw.motor;
  const rawSteering = raw.steering;

  if (typeof rawMotor !== 'number' || !Number.isFinite(rawMotor)) invalidFields.push('motor');
  if (typeof rawSteering !== 'number' || !Number.isFinite(rawSteering)) invalidFields.push('steering');

  return {
    motor: clamp(finiteOr(rawMotor, 0), -1, 1),
    steering: clamp(finiteOr(rawSteering, 0), -1, 1),
    debug: sanitizeDebug(raw.debug),
    invalidFields,
  };
}

/**
 * Traffic steering toward a lane center. `laneOffset` shifts the target sideways
 * (positive = right), e.g. for a driver wandering within its lane.
 */
export function builtInLaneCentering(
  vehicle: VehicleState,
  road: Road,
  targetLane = vehicle.targetLane,
  laneOffset = 0,
): number {
  const personality = vehicle.personality ?? DEFAULT_TRAFFIC_PERSONALITY;
  const laneCenter = road.getLaneCenterOffset(targetLane);
  const laneError = laneCenter - vehicle.lateral;
  const rawLateralError = laneError + laneOffset;
  const targetLaneMismatch = targetLane !== vehicle.laneIndex;
  const isChangingLanes = targetLaneMismatch && vehicle.laneChangeCooldown > 0;
  // Recovery is judged against the lane itself, except for drivers allowed to drift over its lines:
  // they recover when far from where they're drifting to, or when near the road edge.
  const recoveryError = vehicle.personality?.laneDrifter ? rawLateralError : laneError;
  const nearRoadEdge = Math.abs(vehicle.lateral) + vehicle.width / 2 > road.getRoadHalfWidth() - LANE_BODY_RECOVERY_MARGIN;
  const assignedLaneRecovery =
    nearRoadEdge || Math.abs(recoveryError) + vehicle.width / 2 > road.laneWidth / 2 - LANE_BODY_RECOVERY_MARGIN;
  const laneExitRecovery = assignedLaneRecovery && !isChangingLanes;
  const bodyOutsideRoad = Math.abs(vehicle.lateral) + vehicle.width / 2 > road.getRoadHalfWidth();
  const previewDistance = clamp(vehicle.speed * 0.85, 14, 34);
  const previewCurvature = road.sampleAt(vehicle.s + previewDistance).curvature;
  const steeringScale = clamp(vehicle.speed / 22, 0.08, 1);
  const curvatureFeedforward = (previewCurvature * vehicle.speed) / Math.max(0.08, 0.68 * steeringScale);

  const maxLateralVelocity = bodyOutsideRoad
    ? 2.3
    : laneExitRecovery
    ? 2.15
    : isChangingLanes
    ? personality.laneChangeMaxLateralVelocity
    : 0.82;
  const desiredLateralVelocity = clamp(
    rawLateralError * (laneExitRecovery ? 0.92 : isChangingLanes ? 0.78 : 0.58),
    -maxLateralVelocity,
    maxLateralVelocity,
  );
  const actualLateralVelocity = vehicle.speed * Math.sin(vehicle.headingOffset);
  const headingLimit = laneExitRecovery ? 0.38 : 0.32;
  const desiredHeading = Math.asin(clamp(desiredLateralVelocity / Math.max(1, vehicle.speed), -headingLimit, headingLimit));
  const headingCorrection =
    (desiredHeading - vehicle.headingOffset) * (personality.headingGain + (laneExitRecovery ? 0.42 : 0.24));
  const velocityCorrection = (desiredLateralVelocity - actualLateralVelocity) * (laneExitRecovery ? 0.11 : 0.075);
  return clamp(headingCorrection + velocityCorrection + curvatureFeedforward * (laneExitRecovery ? 0.72 : 1), -1, 1);
}

export function builtInAssistLaneKeeping(input: AutopilotInput): number {
  const lane = analyzeLaneDetections(input.laneLines);
  if (lane.confidence < 0.18) return clamp(-input.ego.heading * 1.1, -0.55, 0.55);

  const speed = Math.max(1, input.ego.speed);
  const centerOffset = clamp(lane.centerOffset, -2.3, 2.3);
  const laneExitRecovery =
    Math.abs(centerOffset) + ASSIST_EGO_HALF_WIDTH > ROAD_LANE_WIDTH / 2 - LANE_BODY_RECOVERY_MARGIN;
  const lateralVelocityLimit = laneExitRecovery ? 2.35 : 1.5;
  const lateralVelocityGain = laneExitRecovery ? 1.28 : 1.05;
  const desiredLateralVelocity =
    clamp(centerOffset * lateralVelocityGain, -lateralVelocityLimit, lateralVelocityLimit) *
    clamp(0.72 + lane.confidence * 0.28, 0.72, 1);
  const actualLateralVelocity = speed * Math.sin(input.ego.heading);
  const desiredHeading = Math.asin(clamp(desiredLateralVelocity / speed, laneExitRecovery ? -0.34 : -0.26, laneExitRecovery ? 0.34 : 0.26));
  const headingCorrection = (desiredHeading - input.ego.heading) * (laneExitRecovery ? 1.85 : 1.55);
  const lateralVelocityCorrection = (desiredLateralVelocity - actualLateralVelocity) * (laneExitRecovery ? 0.13 : 0.095);
  const steeringScale = clamp(speed / 22, 0.08, 1);
  const curvatureFeedforwardScale = laneExitRecovery ? 0.62 : 0.86;
  const curvatureFeedforward = clamp((lane.curvature * speed * curvatureFeedforwardScale) / Math.max(0.08, 0.68 * steeringScale), -0.38, 0.38);

  return clamp(headingCorrection + lateralVelocityCorrection + curvatureFeedforward, -1, 1);
}

export function builtInAssistSpeedControl(input: AutopilotInput, desiredSpeed = 31): number {
  const closest = closestVehicleAhead(input.vehicles, input.laneLines);
  const lane = analyzeLaneDetections(input.laneLines, 'preview');
  const previewCurvature = previewLaneCurvatureForTarget(input.laneLines, 0);
  let targetSpeed = desiredSpeed;
  let gapBrake = 0;

  if (lane.confidence > 0.22) {
    targetSpeed = Math.min(
      targetSpeed,
      curveAwareTargetSpeed(Math.max(Math.abs(lane.curvature), Math.abs(previewCurvature)), desiredSpeed),
    );
  }

  if (closest) {
    const leadSpeed = Math.max(0, input.ego.speed + closest.relativeVy);
    const clearGap = closest.relativeY - closest.length / 2 - 2.4;
    const closingSpeed = Math.max(0, input.ego.speed - leadSpeed);
    const desiredGap = 9 + input.ego.speed * 1.15;
    const urgentGap = 4.5 + input.ego.speed * 0.42;
    const timeToCollision = closingSpeed > 0.1 ? clearGap / closingSpeed : Number.POSITIVE_INFINITY;
    const gapError = clearGap - desiredGap;

    if (gapError < 20) {
      targetSpeed = Math.min(targetSpeed, Math.max(3, leadSpeed + gapError * 0.42));
    }
    if (gapError < 0) gapBrake += clamp(gapError * 0.105, -0.9, 0);
    if (clearGap < urgentGap) gapBrake = Math.min(gapBrake, -0.95);
    if (timeToCollision < 1.25) gapBrake = -1;
    else if (timeToCollision < 2.1) gapBrake = Math.min(gapBrake, -0.65);
  }

  const speedError = targetSpeed - input.ego.speed;
  const feedforward = accelerationFeedforward(targetSpeed, input.ego.speed);
  return clamp(feedforward + speedError * 0.105 + gapBrake, -1, 1);
}

export function trafficAutopilot(vehicle: VehicleState, input: TrafficAutopilotInput, laneCount: number): TrafficAutopilotOutput {
  const personality = vehicle.personality ?? DEFAULT_TRAFFIC_PERSONALITY;
  const currentTarget = clamp(vehicle.targetLane, 0, laneCount - 1);
  let targetLane = currentTarget;
  const closest = closestVehicleAhead(input.vehicles, input.laneLines, currentTarget - input.ego.laneIndex);
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
      .map((lane) => ({ lane, score: laneChangeClearanceScore(input, lane, personality) }))
      .filter((candidate) => candidate.score > 0)
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

export function analyzeLaneDetections(laneLines: LaneLineDetections, mode: 'local' | 'preview' = 'local'): LaneAnalysis {
  return analyzeLaneBoundaries(laneLines.left, laneLines.right, mode !== 'preview');
}

export function analyzeLaneDetectionsForTarget(
  laneLines: LaneLineDetections,
  relativeTargetLane: number,
  mode: 'local' | 'preview' = 'local',
): LaneAnalysis {
  if (relativeTargetLane < 0) return analyzeLaneBoundaries(laneLines.farLeft, laneLines.left, mode !== 'preview');
  if (relativeTargetLane > 0) return analyzeLaneBoundaries(laneLines.right, laneLines.farRight, mode !== 'preview');
  return analyzeLaneDetections(laneLines, mode);
}

function previewLaneCurvatureForTarget(laneLines: LaneLineDetections, relativeTargetLane: number): number {
  if (relativeTargetLane < 0) return previewLaneCurvature(laneLines.farLeft, laneLines.left);
  if (relativeTargetLane > 0) return previewLaneCurvature(laneLines.right, laneLines.farRight);
  return previewLaneCurvature(laneLines.left, laneLines.right);
}

function analyzeLaneBoundaries(leftSamples: LaneLineSample[], rightSamples: LaneLineSample[], local = false): LaneAnalysis {
  const left = representativeLinePoint(leftSamples);
  const right = representativeLinePoint(rightSamples);
  const fallbackConfidence = averageConfidence([...leftSamples, ...rightSamples]);

  if (!left && !right) {
    return {
      centerOffset: 0,
      heading: 0,
      curvature: 0,
      confidence: 0,
    };
  }

  const centerNear = lineCenterAtY(leftSamples, rightSamples, 5);
  const centerMid = lineCenterAtY(leftSamples, rightSamples, 30);
  const centerFar = lineCenterAtY(leftSamples, rightSamples, 62);
  // Steering needs geometry near ego. A long quadratic averages upcoming curve
  // transitions into the current curvature, advancing both turn-in and unwind.
  // Keep the longer fit for the public preview helper and speed planning.
  const fit = fitForwardLaneCenterline(leftSamples, rightSamples, local);
  const centerOffset = local && fit ? fit.c0 : centerNear.x;
  const fallbackHeading = Math.atan2(centerFar.x - centerNear.x, Math.max(1, centerFar.y - centerNear.y));
  const headingLookahead = local ? 0 : 18;
  const curvatureLookahead = local ? 0 : 12;
  const headingSlope = fit ? fit.c1 + 2 * fit.c2 * headingLookahead : Math.tan(fallbackHeading);
  const curvatureSlope = fit ? fit.c1 + 2 * fit.c2 * curvatureLookahead : headingSlope;
  const heading = Math.atan(headingSlope);
  const curvature = fit
    ? (2 * fit.c2) / Math.max(0.2, (1 + curvatureSlope * curvatureSlope) ** 1.5)
    : quadraticCurvatureFromThreePoints(centerNear, centerMid, centerFar);

  return {
    centerOffset,
    heading,
    curvature,
    confidence: fit?.confidence ?? clamp((centerNear.confidence + centerMid.confidence + centerFar.confidence) / 3 || fallbackConfidence, 0, 1),
  };
}

export function closestVehicleAhead(
  vehicles: VehicleTrack[],
  laneLines: LaneLineDetections,
  relativeLane = 0,
): VehicleTrack | undefined {
  let closest: VehicleTrack | undefined;
  for (const vehicle of vehicles) {
    // The lane test is the costly part, so skip anything that couldn't be closer.
    if (vehicle.relativeY <= 0 || (closest && vehicle.relativeY >= closest.relativeY)) continue;
    if (isVehicleInLane(vehicle, laneLines, relativeLane)) closest = vehicle;
  }
  return closest;
}

/**
 * True when any part of the vehicle's footprint overlaps the lane `relativeLane`
 * lanes to the right of ego's lane (-1 left, 0 ego's lane, 1 right).
 */
export function isVehicleInLane(vehicle: VehicleTrack, laneLines: LaneLineDetections, relativeLane = 0): boolean {
  const y = vehicle.relativeY;
  const left = laneBoundaryXAtY(laneLines, relativeLane, y);
  const right = laneBoundaryXAtY(laneLines, relativeLane + 1, y);
  const leftAhead = laneBoundaryXAtY(laneLines, relativeLane, y + 1);
  const rightAhead = laneBoundaryXAtY(laneLines, relativeLane + 1, y + 1);
  // Compare in the lane's own frame so a car aligned with a curve ahead is not
  // widened by its yaw relative to ego.
  const laneHeading = Math.atan((leftAhead + rightAhead - left - right) / 2);
  const yaw = vehicle.relativeHeading - laneHeading;
  const halfExtent = (Math.abs(Math.cos(yaw)) * vehicle.width + Math.abs(Math.sin(yaw)) * vehicle.length) / 2;
  const cosHeading = Math.cos(laneHeading);
  const offsetFromLeft = (vehicle.relativeX - left) * cosHeading;
  return offsetFromLeft - halfExtent < (right - left) * cosHeading && offsetFromLeft + halfExtent > 0;
}

/**
 * Lateral position of a lane boundary at forward distance y. Boundary 0 is ego's
 * left line and 1 its right line; missing lines are inferred from the nearest
 * detected one, or from a nominal lane centered on ego when nothing is detected.
 */
function laneBoundaryXAtY(laneLines: LaneLineDetections, boundary: number, y: number): number {
  // Detected lines cover boundaries -1 (farLeft) through 2 (farRight).
  for (let distance = 0; distance <= Math.abs(boundary - 0.5) + 1.5; distance += 1) {
    for (const index of distance === 0 ? [boundary] : [boundary - distance, boundary + distance]) {
      const samples = detectedLaneLine(laneLines, index);
      const x = samples && laneLineXAtY(samples, y);
      if (x !== undefined) return x + (boundary - index) * ROAD_LANE_WIDTH;
    }
  }
  return (boundary - 0.5) * ROAD_LANE_WIDTH;
}

function detectedLaneLine(laneLines: LaneLineDetections, boundary: number): LaneLineSample[] | undefined {
  if (boundary === -1) return laneLines.farLeft;
  if (boundary === 0) return laneLines.left;
  if (boundary === 1) return laneLines.right;
  if (boundary === 2) return laneLines.farRight;
  return undefined;
}

const LANE_EXTRAPOLATION_BASELINE = 10;

/** Interpolates a lane line at y, extending its end segments linearly beyond the detected span. */
function laneLineXAtY(samples: LaneLineSample[], y: number): number | undefined {
  if (samples.length === 0) return undefined;
  // Sensor samples arrive in forward order; only copy when given something else.
  let inOrder = true;
  for (let index = 1; index < samples.length && inOrder; index += 1) inOrder = samples[index - 1].y <= samples[index].y;
  const sorted = inOrder ? samples : [...samples].sort((a, b) => a.y - b.y);

  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid].y < y) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && low < sorted.length) {
    const before = sorted[low - 1];
    const after = sorted[low];
    return before.x + ((after.x - before.x) * (y - before.y)) / (after.y - before.y);
  }
  if (low < sorted.length && sorted[low].y === y) return sorted[low].x;

  // Pair the end sample with the nearest one at least a baseline away (or the
  // farthest available) so sample jitter doesn't dominate the slope.
  const step = low === 0 ? 1 : -1;
  const endIndex = low === 0 ? 0 : sorted.length - 1;
  const end = sorted[endIndex];
  let anchorIndex = endIndex;
  while (
    anchorIndex + step >= 0 &&
    anchorIndex + step < sorted.length &&
    Math.abs(sorted[anchorIndex].y - end.y) < LANE_EXTRAPOLATION_BASELINE
  ) {
    anchorIndex += step;
  }
  const anchor = sorted[anchorIndex];
  if (anchor.y === end.y) return end.x;
  return end.x + ((end.x - anchor.x) * (y - end.y)) / (end.y - anchor.y);
}

export function accelerationFeedforward(targetSpeed: number, currentSpeed: number): number {
  const speedError = targetSpeed - currentSpeed;
  const dragCompensation = 0.00048 * currentSpeed * currentSpeed + 0.004 * currentSpeed;
  const requestedAccel = speedError * 0.09 + dragCompensation;
  return clamp(requestedAccel, -1, 1);
}

function curveAwareTargetSpeed(curvature: number, desiredSpeed: number): number {
  const magnitude = Math.abs(curvature);
  if (magnitude < 0.006) return desiredSpeed;

  const comfortableLateralAcceleration = 5.4;
  const curveSpeed = Math.sqrt(comfortableLateralAcceleration / magnitude);
  return clamp(curveSpeed, 18, desiredSpeed);
}

function trafficSpeedControl(input: TrafficAutopilotInput, desiredSpeed: number, personality = DEFAULT_TRAFFIC_PERSONALITY): number {
  const closest = closestVehicleAhead(input.vehicles, input.laneLines, input.targetLane - input.ego.laneIndex);
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

function laneChangeClearanceScore(input: AutopilotInput, laneIndex: number, personality = DEFAULT_TRAFFIC_PERSONALITY): number {
  let score = 80 * personality.laneChangeEagerness;
  const relativeLane = laneIndex - input.ego.laneIndex;
  for (const vehicle of input.vehicles) {
    if (!isVehicleInLane(vehicle, input.laneLines, relativeLane)) continue;

    const otherSpeed = input.ego.speed + vehicle.relativeVy;
    if (vehicle.relativeY >= 0) {
      const closingSpeed = Math.max(0, input.ego.speed - otherSpeed);
      const requiredAhead =
        personality.laneChangeFrontGap +
        input.ego.speed * personality.laneChangeTimeBuffer * 0.22 +
        closingSpeed * (1.2 - personality.laneChangeEagerness * 0.35);
      if (vehicle.relativeY < requiredAhead) return -1;
      score = Math.min(score, vehicle.relativeY - requiredAhead);
    } else {
      const rearDistance = Math.abs(vehicle.relativeY);
      const rearClosingSpeed = Math.max(0, otherSpeed - input.ego.speed);
      const requiredBehind =
        personality.laneChangeRearGap +
        Math.max(0, otherSpeed) * personality.laneChangeTimeBuffer * 0.25 +
        rearClosingSpeed * (1.45 - personality.laneChangeEagerness * 0.45);
      if (rearDistance < requiredBehind) return -1;
      score = Math.min(score, rearDistance - requiredBehind);
    }
  }
  return score;
}

function representativeLinePoint(samples: LaneLineSample[]): LaneLineSample | undefined {
  return samples
    .filter((sample) => sample.y > 8 && sample.y < 34)
    .sort((a, b) => Math.abs(a.y - 18) - Math.abs(b.y - 18))[0];
}

function lineCenterAtY(leftSamples: LaneLineSample[], rightSamples: LaneLineSample[], y: number): LaneLineSample {
  const left = sampleLineAtY(leftSamples, y);
  const right = sampleLineAtY(rightSamples, y);

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

function previewLaneCurvature(leftSamples: LaneLineSample[], rightSamples: LaneLineSample[]): number {
  const centers = [10, 22, 34, 46, 58, 70, 82]
    .map((y) => lineCenterAtY(leftSamples, rightSamples, y))
    .filter((sample) => sample.confidence > 0.08);

  if (centers.length < 3) return 0;

  let maxCurvature = 0;
  for (let index = 1; index < centers.length - 1; index += 1) {
    const confidence =
      (centers[index - 1].confidence + centers[index].confidence + centers[index + 1].confidence) / 3;
    const curvature = quadraticCurvatureFromThreePoints(centers[index - 1], centers[index], centers[index + 1]);
    maxCurvature = Math.max(maxCurvature, Math.abs(curvature) * clamp(confidence, 0, 1));
  }

  return maxCurvature;
}

function fitForwardLaneCenterline(
  leftSamples: LaneLineSample[],
  rightSamples: LaneLineSample[],
  local = false,
): LaneCenterFit | undefined {
  const samples: LaneLineSample[] = [];

  for (let y = local ? 3 : 5; y <= (local ? 15.5 : 56); y += local ? 2.4 : y < 25 ? 4 : 6) {
    const center = lineCenterAtY(leftSamples, rightSamples, y);
    if (center.confidence > 0.08) samples.push(center);
  }

  if (samples.length < 5) return undefined;

  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  let weightTotal = 0;

  for (const sample of samples) {
    const y = sample.y;
    const y2 = y * y;
    const distanceT = clamp((y - 5) / 51, 0, 1);
    const confidenceWeight = clamp(sample.confidence, 0.08, 1) * (1 - distanceT * 0.62);
    // Local fits trust the road right in front of the car most: full weight at 3 m, 0.3 at 15 m.
    const weight = local
      ? clamp(sample.confidence, 0.08, 1) * (1 - clamp((y - 3) / 12, 0, 1) * 0.7)
      : confidenceWeight;

    s0 += weight;
    s1 += weight * y;
    s2 += weight * y2;
    s3 += weight * y2 * y;
    s4 += weight * y2 * y2;
    t0 += weight * sample.x;
    t1 += weight * sample.x * y;
    t2 += weight * sample.x * y2;
    weightTotal += confidenceWeight;
  }

  const solution = solve3x3([
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2],
  ]);

  if (!solution) return undefined;
  const [c0, c1, c2] = solution;
  return {
    c0,
    c1,
    c2,
    confidence: clamp(weightTotal / samples.length, 0, 1),
  };
}

function quadraticCurvatureFromThreePoints(
  near: LaneLineSample,
  mid: LaneLineSample,
  far: LaneLineSample,
): number {
  const nearToMid = Math.max(1, mid.y - near.y);
  const midToFar = Math.max(1, far.y - mid.y);
  const slopeNear = (mid.x - near.x) / nearToMid;
  const slopeFar = (far.x - mid.x) / midToFar;
  return (slopeFar - slopeNear) / Math.max(1, (nearToMid + midToFar) / 2);
}

function solve3x3(matrix: number[][]): [number, number, number] | undefined {
  const rows = matrix.map((row) => [...row]);

  for (let pivot = 0; pivot < 3; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][pivot]) > Math.abs(rows[bestRow][pivot])) bestRow = row;
    }

    if (Math.abs(rows[bestRow][pivot]) < 1e-9) return undefined;
    [rows[pivot], rows[bestRow]] = [rows[bestRow], rows[pivot]];

    const divisor = rows[pivot][pivot];
    for (let col = pivot; col < 4; col += 1) rows[pivot][col] /= divisor;

    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = rows[row][pivot];
      for (let col = pivot; col < 4; col += 1) rows[row][col] -= factor * rows[pivot][col];
    }
  }

  return [rows[0][3], rows[1][3], rows[2][3]];
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
