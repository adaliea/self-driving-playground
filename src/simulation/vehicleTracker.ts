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
  laneIndex?: number;
  age: number;
  timeSinceMeasurement: number;
  isPredicted: boolean;
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

  constructor(options: Partial<VehicleTrackerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.tracks.clear();
  }

  update(measurements: VehicleMeasurement[], dt: number): VehicleTrack[] {
    const safeDt = clamp(dt, 0, 0.25);

    for (const track of this.tracks.values()) this.predictTrack(track, safeDt);

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

  private predictTrack(track: TrackState, dt: number): void {
    predictAxis(track.lateral, dt, this.options.accelerationStdDev);
    predictAxis(track.longitudinal, dt, this.options.accelerationStdDev);
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
    track.laneIndex = measurement.laneIndex;
    track.timeSinceMeasurement = 0;
    track.isPredicted = false;
  }
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
    laneIndex: measurement.laneIndex,
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
    laneIndex: track.laneIndex,
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
