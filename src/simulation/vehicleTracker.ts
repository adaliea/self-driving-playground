import type { VehicleMeasurement, VehicleTrack } from '../types';
import { clamp, normalizeAngle } from './math';

export interface VehicleTrackerOptions {
  /** Seconds a track may coast without a measurement before removal. */
  maxPredictionTime: number;
  /** Relative acceleration standard deviation used by the motion model. */
  accelerationStdDev: number;
  /** Heading drift standard deviation in radians per square-root second. */
  headingProcessStdDev: number;
  /** Time constant for confidence decay during prediction-only frames. */
  confidenceDecayTime: number;
}

interface AxisState {
  position: number;
  velocity: number;
  p00: number;
  p01: number;
  p11: number;
}

interface ScalarState {
  value: number;
  variance: number;
}

interface TrackState {
  id: string;
  lateral: AxisState;
  longitudinal: AxisState;
  heading: ScalarState;
  width: ScalarState;
  length: ScalarState;
  confidence: number;
  age: number;
  timeSinceMeasurement: number;
  isPredicted: boolean;
}

/**
 * Ego motion for the latest tick. Tracks live in the ego frame, which turns
 * and changes speed with ego; the tracker undoes that before applying its
 * constant-velocity model so ego motion is not mistaken for target motion.
 */
export interface TrackerEgoMotion {
  /** Ego forward speed in meters per second at the current tick. */
  speed: number;
  /** Ego world yaw rate in radians per second (same sign as heading: positive turns right). */
  yawRate: number;
  /**
   * Ego heading relative to the road, in radians. Optional: with it the tracker
   * separates road curvature from ego's own steering and assumes other cars
   * follow the curve too; without it, targets are assumed to keep a constant
   * world velocity.
   */
  heading?: number;
}

const DEFAULT_OPTIONS: VehicleTrackerOptions = {
  maxPredictionTime: 0.42,
  accelerationStdDev: 3.2,
  headingProcessStdDev: degreesToRadians(5),
  confidenceDecayTime: 0.34,
};

/**
 * Small constant-velocity Kalman tracker used by the built-in perception stack.
 * Measurements are associated by the simulator-provided measurement id so the
 * lesson can focus on filtering rather than multi-object data association.
 */
export class VehicleTracker {
  private readonly tracks = new Map<string, TrackState>();
  private readonly options: VehicleTrackerOptions;
  private previousEgo: TrackerEgoMotion | undefined;
  private roadCurvature = 0;

  constructor(options: Partial<VehicleTrackerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.tracks.clear();
    this.previousEgo = undefined;
    this.roadCurvature = 0;
  }

  /**
   * @param ego Ego speed, world yaw rate, and road-relative heading for this
   *   tick (input.ego fits). Without it the tracker assumes the ego frame does
   *   not rotate or change speed.
   */
  update(measurements: VehicleMeasurement[], dt: number, ego?: TrackerEgoMotion): VehicleTrack[] {
    const safeDt = clamp(dt, 0, 0.25);
    const frameMotion = egoFrameMotion(ego, this.previousEgo, this.roadCurvature, safeDt);
    if (frameMotion) this.roadCurvature = frameMotion.roadCurvature;
    this.previousEgo = ego && Number.isFinite(ego.speed) ? { ...ego } : undefined;

    for (const track of this.tracks.values()) this.predictTrack(track, safeDt, frameMotion);

    for (const measurement of measurements) {
      const existing = this.tracks.get(measurement.id);
      if (existing) this.updateTrack(existing, measurement);
      else this.tracks.set(measurement.id, initializeTrack(measurement, safeDt));
    }

    for (const [id, track] of this.tracks) {
      if (track.timeSinceMeasurement > this.options.maxPredictionTime) this.tracks.delete(id);
    }

    return [...this.tracks.values()]
      .map(toVehicleTrack)
      .sort((a, b) => a.relativeY - b.relativeY);
  }

  private predictTrack(track: TrackState, dt: number, frame: EgoFrameMotion | undefined): void {
    predictAxis(track.lateral, dt, this.options.accelerationStdDev);
    predictAxis(track.longitudinal, dt, this.options.accelerationStdDev);
    if (frame) {
      const targetTurn = compensateEgoMotion(track.lateral, track.longitudinal, frame);
      track.heading.value = normalizeAngle(track.heading.value - frame.yawDelta + targetTurn);
    }
    track.heading.variance += this.options.headingProcessStdDev ** 2 * dt;
    track.width.variance += 0.0025 * dt;
    track.length.variance += 0.0064 * dt;
    track.age += dt;
    track.timeSinceMeasurement += dt;
    track.isPredicted = true;
    track.confidence *= Math.exp(-dt / this.options.confidenceDecayTime);
  }

  private updateTrack(track: TrackState, measurement: VehicleMeasurement): void {
    updateAxis(track.lateral, measurement.relativeX, measurement.uncertainty.lateralPosition ** 2);
    updateAxis(track.longitudinal, measurement.relativeY, measurement.uncertainty.longitudinalPosition ** 2);
    updateAngle(track.heading, measurement.relativeHeading, measurement.uncertainty.heading ** 2);

    const widthStdDev = Math.max(0.045, measurement.uncertainty.lateralPosition * 0.35);
    const lengthStdDev = Math.max(0.08, measurement.uncertainty.longitudinalPosition * 0.18);
    updateScalar(track.width, measurement.width, widthStdDev ** 2);
    updateScalar(track.length, measurement.length, lengthStdDev ** 2);

    track.confidence = clamp(track.confidence * 0.58 + measurement.confidence * 0.42, 0, 1);
    track.timeSinceMeasurement = 0;
    track.isPredicted = false;
  }
}

interface EgoFrameMotion {
  /** World yaw change of the ego frame over the tick, in radians. */
  yawDelta: number;
  /** Road curvature (1/m, positive curving right) estimated from ego yaw versus road-relative heading. */
  roadCurvature: number;
  dt: number;
  /** Ego forward speed at the previous and current tick. */
  previousSpeed: number;
  currentSpeed: number;
  /**
   * Position correction in the previous ego frame: the constant-velocity step
   * assumed ego drove straight ahead at its previous speed, so add that back
   * and subtract where ego actually went along its arc.
   */
  offsetX: number;
  offsetY: number;
}

// Physically the ego yaws well under 1 rad/s; anything faster is a reset/teleport
// and rotating every track by it would do more harm than good.
const MAX_PLAUSIBLE_YAW_RATE = 3;
// Tighter than the sharpest generated road turn; bounds curvature noise at low speed.
const MAX_ROAD_CURVATURE = 0.04;

function egoFrameMotion(
  ego: TrackerEgoMotion | undefined,
  previous: TrackerEgoMotion | undefined,
  lastRoadCurvature: number,
  dt: number,
): EgoFrameMotion | undefined {
  if (!ego || dt <= 0 || !Number.isFinite(ego.speed)) return undefined;
  const yawRate = Number.isFinite(ego.yawRate) && Math.abs(ego.yawRate) <= MAX_PLAUSIBLE_YAW_RATE ? ego.yawRate : 0;
  const yawDelta = yawRate * dt;
  const currentSpeed = ego.speed;
  const previousSpeed = previous?.speed ?? currentSpeed;
  // Ego drives a short arc: its chord points half way through the turn.
  const distance = 0.5 * (previousSpeed + currentSpeed) * dt;

  // World yaw = road heading + road-relative heading, so whatever yaw the
  // road-relative heading change does not explain is the road curving under ego.
  let roadCurvature = ego.heading === undefined ? 0 : lastRoadCurvature;
  if (ego.heading !== undefined && previous?.heading !== undefined) {
    const roadDistance = distance * Math.cos(ego.heading);
    if (roadDistance > 0.05) {
      const roadTurn = yawDelta - normalizeAngle(ego.heading - previous.heading);
      roadCurvature = clamp(roadTurn / roadDistance, -MAX_ROAD_CURVATURE, MAX_ROAD_CURVATURE);
    }
  }

  return {
    yawDelta,
    roadCurvature,
    dt,
    previousSpeed,
    currentSpeed,
    offsetX: -distance * Math.sin(yawDelta / 2),
    offsetY: previousSpeed * dt - distance * Math.cos(yawDelta / 2),
  };
}

/**
 * Moves a freshly predicted state from the previous ego frame into the current one.
 *
 * The constant-velocity step already moved each track by its relative velocity
 * assuming ego drove straight at its old speed. This corrects for where ego
 * actually went and rotates position into the turned frame. Velocity is split
 * into the target's world velocity (relative velocity + ego speed) and ego's
 * own speed; the world part rotates with the frame, less the turn the target
 * makes itself by following the road curve, then ego's new speed is
 * subtracted. Covariance blocks are rotated too, keeping per-axis marginals
 * so the filter stays decoupled per axis.
 *
 * @returns The target's own world heading change, assumed from road curvature.
 */
function compensateEgoMotion(lateral: AxisState, longitudinal: AxisState, frame: EgoFrameMotion): number {
  const cos = Math.cos(frame.yawDelta);
  const sin = Math.sin(frame.yawDelta);
  const x = lateral.position + frame.offsetX;
  const y = longitudinal.position + frame.offsetY;
  lateral.position = x * cos - y * sin;
  longitudinal.position = x * sin + y * cos;

  const worldVx = lateral.velocity;
  const worldVy = longitudinal.velocity + frame.previousSpeed;
  const targetTurn = frame.roadCurvature * worldVy * frame.dt;
  const velocityCos = Math.cos(frame.yawDelta - targetTurn);
  const velocitySin = Math.sin(frame.yawDelta - targetTurn);
  lateral.velocity = worldVx * velocityCos - worldVy * velocitySin;
  longitudinal.velocity = worldVx * velocitySin + worldVy * velocityCos - frame.currentSpeed;

  rotateCovariance(lateral, longitudinal, cos, sin, velocityCos, velocitySin);
  return targetTurn;
}

/**
 * Rotates position by one angle and velocity by another, dropping the cross-axis
 * terms the rotation would create. Each axis keeps its exact marginal variance
 * and the result stays positive semi-definite.
 */
function rotateCovariance(
  lateral: AxisState,
  longitudinal: AxisState,
  cos: number,
  sin: number,
  velocityCos: number,
  velocitySin: number,
): void {
  const { p00: x00, p01: x01, p11: x11 } = lateral;
  const { p00: y00, p01: y01, p11: y11 } = longitudinal;
  lateral.p00 = cos * cos * x00 + sin * sin * y00;
  lateral.p01 = cos * velocityCos * x01 + sin * velocitySin * y01;
  lateral.p11 = velocityCos * velocityCos * x11 + velocitySin * velocitySin * y11;
  longitudinal.p00 = sin * sin * x00 + cos * cos * y00;
  longitudinal.p01 = sin * velocitySin * x01 + cos * velocityCos * y01;
  longitudinal.p11 = velocitySin * velocitySin * x11 + velocityCos * velocityCos * y11;
}

function initializeTrack(measurement: VehicleMeasurement, dt: number): TrackState {
  const lateralVariance = measurement.uncertainty.lateralPosition ** 2;
  const longitudinalVariance = measurement.uncertainty.longitudinalPosition ** 2;
  const widthStdDev = Math.max(0.045, measurement.uncertainty.lateralPosition * 0.35);
  const lengthStdDev = Math.max(0.08, measurement.uncertainty.longitudinalPosition * 0.18);

  return {
    id: measurement.id,
    lateral: initializeAxis(measurement.relativeX, lateralVariance),
    longitudinal: initializeAxis(measurement.relativeY, longitudinalVariance),
    heading: { value: measurement.relativeHeading, variance: measurement.uncertainty.heading ** 2 },
    width: { value: measurement.width, variance: widthStdDev ** 2 },
    length: { value: measurement.length, variance: lengthStdDev ** 2 },
    confidence: measurement.confidence,
    age: dt,
    timeSinceMeasurement: 0,
    isPredicted: false,
  };
}

function initializeAxis(position: number, positionVariance: number): AxisState {
  return {
    position,
    velocity: 0,
    p00: Math.max(positionVariance, 1e-6),
    p01: 0,
    // A first box does not reveal velocity. Start uncertain and let subsequent
    // positions establish it instead of borrowing simulator ground truth.
    p11: 36,
  };
}

function predictAxis(axis: AxisState, dt: number, accelerationStdDev: number): void {
  const accelerationVariance = accelerationStdDev ** 2;
  const dt2 = dt ** 2;
  const dt3 = dt2 * dt;
  const dt4 = dt2 ** 2;
  const previousP01 = axis.p01;
  const previousP11 = axis.p11;

  axis.position += axis.velocity * dt;
  axis.p00 += 2 * dt * previousP01 + dt2 * previousP11 + 0.25 * dt4 * accelerationVariance;
  axis.p01 += dt * previousP11 + 0.5 * dt3 * accelerationVariance;
  axis.p11 += dt2 * accelerationVariance;
}

function updateAxis(axis: AxisState, measurement: number, measurementVariance: number): void {
  const safeVariance = Math.max(measurementVariance, 1e-6);
  const innovationVariance = axis.p00 + safeVariance;
  const positionGain = axis.p00 / innovationVariance;
  const velocityGain = axis.p01 / innovationVariance;
  const innovation = measurement - axis.position;
  const previousP00 = axis.p00;
  const previousP01 = axis.p01;
  const previousP11 = axis.p11;

  axis.position += positionGain * innovation;
  axis.velocity += velocityGain * innovation;
  axis.p00 = Math.max(1e-9, (1 - positionGain) * previousP00);
  axis.p01 = (1 - positionGain) * previousP01;
  axis.p11 = Math.max(1e-9, previousP11 - velocityGain * previousP01);
}

function updateScalar(state: ScalarState, measurement: number, measurementVariance: number): void {
  const gain = state.variance / (state.variance + Math.max(measurementVariance, 1e-6));
  state.value += gain * (measurement - state.value);
  state.variance = Math.max(1e-9, (1 - gain) * state.variance);
}

function updateAngle(state: ScalarState, measurement: number, measurementVariance: number): void {
  const gain = state.variance / (state.variance + Math.max(measurementVariance, 1e-6));
  state.value = normalizeAngle(state.value + gain * normalizeAngle(measurement - state.value));
  state.variance = Math.max(1e-9, (1 - gain) * state.variance);
}

function toVehicleTrack(track: TrackState): VehicleTrack {
  return {
    id: track.id,
    relativeX: track.lateral.position,
    relativeY: track.longitudinal.position,
    relativeVx: track.lateral.velocity,
    relativeVy: track.longitudinal.velocity,
    relativeHeading: track.heading.value,
    width: track.width.value,
    length: track.length.value,
    confidence: clamp(track.confidence, 0, 1),
    age: track.age,
    timeSinceMeasurement: track.timeSinceMeasurement,
    isPredicted: track.isPredicted,
    uncertainty: {
      lateralPosition: Math.sqrt(track.lateral.p00),
      longitudinalPosition: Math.sqrt(track.longitudinal.p00),
      lateralVelocity: Math.sqrt(track.lateral.p11),
      longitudinalVelocity: Math.sqrt(track.longitudinal.p11),
      heading: Math.sqrt(track.heading.variance),
    },
  };
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}
