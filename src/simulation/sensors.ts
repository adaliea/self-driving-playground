import type {
  AutopilotInput,
  LaneLineDetections,
  LaneLineSample,
  PlaygroundSettings,
  VehicleMeasurement,
  VehicleTrack,
} from '../types';
import { clamp, normalizeAngle } from './math';
import type { TrafficAutopilotInput } from './controllers';
import type { Road } from './road';
import type { SeededRandom } from './random';
import type { VehicleState } from './vehicle';
import { VehicleTracker } from './vehicleTracker';

export interface SensorNoiseOptions {
  noisyLaneLines: boolean;
  noisyVehicles: boolean;
}

interface DetectionError {
  relativeX: number;
  relativeY: number;
  relativeHeading: number;
  width: number;
  length: number;
}

interface DetectionNoiseScale extends DetectionError {
  outlierProbability: number;
}

interface MeasurementNoiseState {
  latentBias: DetectionError;
  dropoutRemaining: number;
}

interface VehicleObservationFrame {
  measurements: VehicleMeasurement[];
  truthTracks: VehicleTrack[];
}

// Keep only a small colored component. Most raw detector uncertainty should be
// fresh frame noise now that temporal filtering belongs to the tracker.
const CORRELATED_BIAS_WEIGHT = 0.22;
const INDEPENDENT_NOISE_WEIGHT = Math.sqrt(1 - CORRELATED_BIAS_WEIGHT ** 2);

const SENSOR_STATION_CULL_BEHIND = 90;
const SENSOR_STATION_CULL_AHEAD = 220;

const EGO_LANE_SAMPLE_DISTANCES = laneSampleDistances();
const TRAFFIC_LANE_SAMPLE_DISTANCES = Array.from({ length: 19 }, (_, index) => -45 + index * 10);

export class SensorSimulator {
  private readonly measurementNoise = new Map<string, Map<string, MeasurementNoiseState>>();
  private readonly vehicleTrackers = new Map<string, VehicleTracker>();
  private readonly trackerNoiseModes = new Map<string, boolean>();

  reset(): void {
    this.measurementNoise.clear();
    this.vehicleTrackers.clear();
    this.trackerNoiseModes.clear();
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

    const observation = this.observeVehicles(subject, vehicles, road, settings.noisyVehicles, rng, dt);
    const tracker = this.getVehicleTracker(subject.id);
    const previousNoiseMode = this.trackerNoiseModes.get(subject.id);
    if (previousNoiseMode !== undefined && previousNoiseMode !== settings.noisyVehicles) tracker.reset();
    this.trackerNoiseModes.set(subject.id, settings.noisyVehicles);
    const tracks = tracker.update(observation.measurements, dt);

    return {
      dt,
      ego,
      vehicles: tracks,
      vehicleMeasurements: observation.measurements,
      laneLines: this.detectLaneLines(subject, road, settings.noisyLaneLines, rng),
    };
  }

  createTrafficInput(
    subject: VehicleState,
    vehicles: VehicleState[],
    road: Road,
    rng: SeededRandom,
    dt: number,
  ): TrafficAutopilotInput {
    const laneIndex = road.getLaneIndex(subject.lateral);

    const observation = this.observeVehicles(subject, vehicles, road, false, rng, dt);
    return {
      dt,
      ego: {
        speed: subject.speed,
        heading: subject.headingOffset,
        laneIndex,
      },
      vehicles: observation.truthTracks,
      vehicleMeasurements: observation.measurements,
      laneLines: traceTrafficLaneLines(subject, road),
      targetLane: clamp(subject.targetLane, 0, road.laneCount - 1),
    };
  }

  private observeVehicles(
    subject: VehicleState,
    vehicles: VehicleState[],
    road: Road,
    noisy: boolean,
    rng: SeededRandom,
    dt: number,
  ): VehicleObservationFrame {
    const subjectPose = road.worldPointAt(subject.s, subject.lateral);
    const subjectHeading = subjectPose.heading + subject.headingOffset;
    const forward = { x: Math.sin(subjectHeading), y: Math.cos(subjectHeading) };
    const right = { x: Math.cos(subjectHeading), y: -Math.sin(subjectHeading) };
    const measurements: VehicleMeasurement[] = [];
    const truthTracks: VehicleTrack[] = [];
    const visibleIds = new Set<string>();
    const subjectNoise = this.getMeasurementNoiseMap(subject.id);

    for (const vehicle of vehicles) {
      if (vehicle.id === subject.id) continue;
      // Road distance bounds straight-line distance, so this cheap check never drops a visible vehicle.
      const stationDelta = vehicle.s - subject.s;
      if (stationDelta < -SENSOR_STATION_CULL_BEHIND || stationDelta > SENSOR_STATION_CULL_AHEAD) continue;
      const pose = road.worldPointAt(vehicle.s, vehicle.lateral);
      const dx = pose.x - subjectPose.x;
      const dy = pose.y - subjectPose.y;
      const relativeX = dx * right.x + dy * right.y;
      const relativeY = dx * forward.x + dy * forward.y;
      const vehicleHeading = pose.heading + vehicle.headingOffset;
      const relativeHeading = normalizeAngle(vehicleHeading - subjectHeading);

      if (relativeY < -42 || relativeY > 135 || Math.abs(relativeX) > 20) continue;
      visibleIds.add(vehicle.id);
      const forwardDistance = Math.max(0, relativeY);
      const range = Math.hypot(relativeX, relativeY);
      const distanceT = clamp(forwardDistance / 135, 0, 1);
      const lateralT = clamp(Math.abs(relativeX) / 20, 0, 1);
      const quality = clamp(1 - distanceT * 0.7 - lateralT * 0.15, 0.2, 1);
      const truth: VehicleTrack = {
        id: vehicle.id,
        relativeX,
        relativeY,
        relativeVx: vehicle.speed * Math.sin(relativeHeading),
        relativeVy: vehicle.speed * Math.cos(relativeHeading) - subject.speed,
        relativeHeading,
        width: vehicle.width,
        length: vehicle.length,
        confidence: 1,
        age: 0,
        timeSinceMeasurement: 0,
        isPredicted: false,
        uncertainty: {
          lateralPosition: 0,
          longitudinalPosition: 0,
          lateralVelocity: 0,
          longitudinalVelocity: 0,
          heading: 0,
        },
      };
      truthTracks.push(truth);

      if (!noisy) {
        measurements.push(measurementFromTruth(truth));
        continue;
      }

      const scale = detectionNoiseScale(range, lateralT);
      const previous = subjectNoise.get(vehicle.id);
      const correlation = Math.exp(-Math.max(dt, 0) / 0.48);
      const innovation = Math.sqrt(Math.max(0, 1 - correlation ** 2));
      const outlierScale = rng.chance(scale.outlierProbability) ? rng.range(2.2, 3.8) : 1;
      const latentBias = evolveDetectionError(previous?.latentBias, correlation, innovation, rng);
      const independentError = sampleDetectionError(rng, outlierScale);
      const combinedError = combineDetectionErrors(latentBias, independentError);
      const noiseState: MeasurementNoiseState = {
        latentBias,
        dropoutRemaining: previous?.dropoutRemaining ?? 0,
      };
      subjectNoise.set(vehicle.id, noiseState);

      if (shouldDropMeasurement(noiseState, distanceT, lateralT, rng, dt)) continue;
      measurements.push(noisyMeasurement(truth, scale, combinedError, quality, outlierScale, rng));
    }

    for (const id of subjectNoise.keys()) {
      if (!visibleIds.has(id)) subjectNoise.delete(id);
    }

    return {
      measurements: measurements.sort((a, b) => a.relativeY - b.relativeY),
      truthTracks: truthTracks.sort((a, b) => a.relativeY - b.relativeY),
    };
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

    for (const ahead of EGO_LANE_SAMPLE_DISTANCES) {
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

  private getMeasurementNoiseMap(subjectId: string): Map<string, MeasurementNoiseState> {
    const existing = this.measurementNoise.get(subjectId);
    if (existing) return existing;
    const next = new Map<string, MeasurementNoiseState>();
    this.measurementNoise.set(subjectId, next);
    return next;
  }

  private getVehicleTracker(subjectId: string): VehicleTracker {
    const existing = this.vehicleTrackers.get(subjectId);
    if (existing) return existing;
    const next = new VehicleTracker();
    this.vehicleTrackers.set(subjectId, next);
    return next;
  }
}

function detectionNoiseScale(range: number, lateralT: number): DetectionNoiseScale {
  const distance = clamp(range, 0, 145);
  return {
    // Camera geometry constrains image-plane/lateral position better than depth.
    relativeX: 0.035 + distance * 0.0022 + distance ** 2 * 0.000018 + lateralT * 0.08,
    relativeY: 0.08 + distance * 0.006 + distance ** 2 * 0.000095,
    relativeHeading: degreesToRadians(1 + distance * 0.04 + distance ** 2 * 0.00025 + lateralT * 2),
    width: 0.03 + distance * 0.00065,
    length: 0.06 + distance * 0.0018,
    outlierProbability: 0.004 + (distance / 145) ** 2 * 0.016,
  };
}

function evolveDetectionError(
  previous: DetectionError | undefined,
  correlation: number,
  innovation: number,
  rng: SeededRandom,
): DetectionError {
  const evolve = (key: keyof DetectionError): number => {
    if (!previous) return rng.gaussian(0, 1);
    return previous[key] * correlation + rng.gaussian(0, innovation);
  };
  return {
    relativeX: evolve('relativeX'),
    relativeY: evolve('relativeY'),
    relativeHeading: evolve('relativeHeading'),
    width: evolve('width'),
    length: evolve('length'),
  };
}

function sampleDetectionError(rng: SeededRandom, standardDeviation = 1): DetectionError {
  return {
    relativeX: rng.gaussian(0, standardDeviation),
    relativeY: rng.gaussian(0, standardDeviation),
    relativeHeading: rng.gaussian(0, standardDeviation),
    width: rng.gaussian(0, standardDeviation),
    length: rng.gaussian(0, standardDeviation),
  };
}

function combineDetectionErrors(bias: DetectionError, independent: DetectionError): DetectionError {
  const combine = (key: keyof DetectionError): number =>
    bias[key] * CORRELATED_BIAS_WEIGHT + independent[key] * INDEPENDENT_NOISE_WEIGHT;
  return {
    relativeX: combine('relativeX'),
    relativeY: combine('relativeY'),
    relativeHeading: combine('relativeHeading'),
    width: combine('width'),
    length: combine('length'),
  };
}

function noisyMeasurement(
  truth: VehicleTrack,
  scale: DetectionNoiseScale,
  error: DetectionError,
  quality: number,
  outlierScale: number,
  rng: SeededRandom,
): VehicleMeasurement {
  const uncertaintyMultiplier = Math.hypot(
    CORRELATED_BIAS_WEIGHT,
    INDEPENDENT_NOISE_WEIGHT * outlierScale,
  );
  return {
    id: truth.id,
    relativeX: truth.relativeX + error.relativeX * scale.relativeX,
    relativeY: truth.relativeY + error.relativeY * scale.relativeY,
    relativeHeading: normalizeAngle(truth.relativeHeading + error.relativeHeading * scale.relativeHeading),
    width: Math.max(1.4, truth.width + error.width * scale.width),
    length: Math.max(3.4, truth.length + error.length * scale.length),
    confidence: clamp(quality - (outlierScale > 1 ? 0.16 : 0) + rng.gaussian(0, 0.025), 0.25, 0.99),
    uncertainty: {
      lateralPosition: scale.relativeX * uncertaintyMultiplier,
      longitudinalPosition: scale.relativeY * uncertaintyMultiplier,
      heading: scale.relativeHeading * uncertaintyMultiplier,
    },
  };
}

function measurementFromTruth(truth: VehicleTrack): VehicleMeasurement {
  return {
    id: truth.id,
    relativeX: truth.relativeX,
    relativeY: truth.relativeY,
    relativeHeading: truth.relativeHeading,
    width: truth.width,
    length: truth.length,
    confidence: 1,
    uncertainty: {
      lateralPosition: 0,
      longitudinalPosition: 0,
      heading: 0,
    },
  };
}

function shouldDropMeasurement(
  state: MeasurementNoiseState,
  distanceT: number,
  lateralT: number,
  rng: SeededRandom,
  dt: number,
): boolean {
  if (state.dropoutRemaining > 0) {
    state.dropoutRemaining = Math.max(0, state.dropoutRemaining - dt);
    return true;
  }

  // Dropouts begin infrequently but persist for a short burst. This produces
  // realistic missed-observation runs without making the tracker output flicker.
  const startsPerSecond = 0.015 + distanceT ** 2 * 0.19 + lateralT * 0.07;
  const startProbability = 1 - Math.exp(-startsPerSecond * Math.max(dt, 0));
  if (!rng.chance(startProbability)) return false;
  state.dropoutRemaining = rng.range(0.055, 0.22);
  return true;
}

/**
 * Exact lane lines for traffic controllers. Traffic checks lane occupancy behind
 * it before changing lanes, so these span the whole vehicle sensor range rather
 * than the ego camera's forward view. One road sample per distance feeds all
 * four boundaries because this runs for every traffic car each step.
 */
function traceTrafficLaneLines(subject: VehicleState, road: Road): LaneLineDetections {
  const subjectPose = road.worldPointAt(subject.s, subject.lateral);
  const subjectHeading = subjectPose.heading + subject.headingOffset;
  const sinHeading = Math.sin(subjectHeading);
  const cosHeading = Math.cos(subjectHeading);
  const laneIndex = road.getLaneIndex(subject.lateral);
  const offsets = [
    road.getBoundaryOffset(Math.max(0, laneIndex - 1)),
    road.getBoundaryOffset(laneIndex),
    road.getBoundaryOffset(laneIndex + 1),
    road.getBoundaryOffset(Math.min(road.laneCount, laneIndex + 2)),
  ];
  const lines: LaneLineSample[][] = [[], [], [], []];

  for (const ahead of TRAFFIC_LANE_SAMPLE_DISTANCES) {
    const sample = road.sampleAt(subject.s + ahead);
    const rightX = Math.cos(sample.heading);
    const rightY = -Math.sin(sample.heading);
    for (let line = 0; line < 4; line += 1) {
      const dx = sample.x + rightX * offsets[line] - subjectPose.x;
      const dy = sample.y + rightY * offsets[line] - subjectPose.y;
      lines[line].push({
        x: dx * cosHeading - dy * sinHeading,
        y: dx * sinHeading + dy * cosHeading,
        confidence: 1,
      });
    }
  }

  return { farLeft: lines[0], left: lines[1], right: lines[2], farRight: lines[3] };
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
