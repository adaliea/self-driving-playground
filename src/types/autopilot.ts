/**
 * Normalized output returned by a user or built-in autopilot controller.
 */
export interface AutopilotOutput {
  /**
   * Normalized motor command.
   *
   * -1 means full braking/reverse force.
   *  0 means coast.
   *  1 means full acceleration.
   *
   * Values must be clamped to [-1, 1].
   * The simulator defensively clamps this value even if user code returns an invalid value.
   */
  motor: number;

  /**
   * Normalized steering command.
   *
   * -1 means maximum left steering.
   *  0 means no steering correction.
   *  1 means maximum right steering.
   *
   * Values must be clamped to [-1, 1].
   * The simulator defensively clamps this value even if user code returns an invalid value.
   */
  steering: number;

  /**
   * Optional requested lane index.
   *
   * This is mainly used by traffic vehicles for lane changes.
   * For the MVP, expose this in the API but do not require ego lane-changing UI yet.
   */
  targetLane?: number;

  /**
   * Optional structured debug data. The simulator never trusts this for physics,
   * but the UI can display PID terms when examples or snippets choose to provide them.
   */
  debug?: AutopilotDebug;
}

/**
 * Simulation input passed into the autopilot function each control tick.
 */
export interface AutopilotInput {
  /**
   * Simulation timestep in seconds.
   */
  dt: number;

  /**
   * Ego vehicle state.
   */
  ego: EgoState;

  /**
   * Stable vehicle tracks produced from the raw measurements.
   *
   * Tracks predict through short sensor dropouts and include velocity and
   * uncertainty estimates. Most control examples should use this collection.
   */
  vehicles: VehicleTrack[];

  /**
   * Raw, intermittent vehicle observations before temporal tracking.
   *
   * Use these for perception and estimation experiments. A measurement can be
   * absent for a frame even while its corresponding track remains in vehicles.
   */
  vehicleMeasurements: VehicleMeasurement[];

  /**
   * Detected lane-line samples in ego-relative coordinates.
   */
  laneLines: LaneLineDetections;

  /**
   * Current target lane for the controller.
   *
   * For the ego vehicle MVP, this will usually match ego.laneIndex.
   * For traffic vehicles, this can differ from laneIndex during lane changes.
   */
  targetLane: number;
}

/**
 * Minimal ego-state summary visible to user code.
 */
export interface EgoState {
  /**
   * Current forward speed in meters per second.
   */
  speed: number;

  /**
   * Ego heading relative to the road/world frame, in radians.
   */
  heading: number;

  /**
   * Current lane index.
   * For a 3-lane road, valid values are 0, 1, and 2.
   */
  laneIndex: number;
}

/**
 * Uncertainty attached to one raw vehicle observation.
 * Values are one-standard-deviation estimates in meters or radians.
 */
export interface VehicleMeasurementUncertainty {
  lateralPosition: number;
  longitudinalPosition: number;
  heading: number;
}

/**
 * One noisy sensor observation before temporal tracking.
 */
export interface VehicleMeasurement {
  /**
   * Association hint supplied by this playground's detector.
   * It is stable for one simulated vehicle, but a production detector may not
   * provide a reliable identity before tracking.
   */
  id: string;

  /**
   * Lateral position relative to ego, in meters.
   * Negative means left, positive means right.
   */
  relativeX: number;

  /**
   * Longitudinal position relative to ego, in meters.
   * Positive means ahead, negative means behind.
   */
  relativeY: number;

  /**
   * Observed vehicle yaw relative to ego heading, in radians.
   * Positive angles rotate clockwise/right in the ego-relative top-down view.
   */
  relativeHeading: number;

  width: number;
  length: number;
  confidence: number;
  uncertainty: VehicleMeasurementUncertainty;

  /**
   * Lane associated with this measurement if known.
   */
  laneIndex?: number;
}

/**
 * Uncertainty attached to a temporally filtered vehicle track.
 * Values are one-standard-deviation estimates in meters, meters per second,
 * or radians.
 */
export interface VehicleTrackUncertainty {
  lateralPosition: number;
  longitudinalPosition: number;
  lateralVelocity: number;
  longitudinalVelocity: number;
  heading: number;
}

/**
 * A tracker estimate for one nearby vehicle in ego-relative coordinates.
 */
export interface VehicleTrack {
  /** Stable identity assigned by the tracker. */
  id: string;

  relativeX: number;
  relativeY: number;
  relativeVx: number;
  relativeVy: number;
  relativeHeading: number;
  width: number;
  length: number;
  confidence: number;
  laneIndex?: number;

  /** Seconds since this track was initialized. */
  age: number;

  /** Seconds since a raw measurement last updated this track. */
  timeSinceMeasurement: number;

  /** True when this frame's pose is prediction-only because no measurement arrived. */
  isPredicted: boolean;

  uncertainty: VehicleTrackUncertainty;
}

/**
 * Backwards-compatible name for a tracked vehicle.
 * @deprecated Prefer VehicleTrack in new examples.
 */
export type VehicleDetection = VehicleTrack;

/**
 * A sampled point on a detected lane line in ego-relative coordinates.
 */
export interface LaneLineSample {
  /**
   * Lateral position relative to ego, in meters.
   */
  x: number;

  /**
   * Longitudinal position relative to ego, in meters.
   */
  y: number;

  confidence: number;
}

/**
 * Lane detections around the current ego lane. The "far" lines are included so
 * lane-change examples can reason about adjacent lanes later.
 */
export interface LaneLineDetections {
  left: LaneLineSample[];
  right: LaneLineSample[];
  farLeft: LaneLineSample[];
  farRight: LaneLineSample[];
}

/**
 * Interpreted lane geometry returned by helper functions such as
 * analyzeLaneRegression.
 */
export interface LaneAnalysis {
  /**
   * Estimated lateral offset from the target lane center, in meters.
   * Positive means the lane center is to the right of ego.
   */
  centerOffset: number;

  /**
   * Estimated lane heading error ahead of the vehicle, in radians.
   */
  heading: number;

  /**
   * Estimated signed lane curvature ahead of the vehicle.
   */
  curvature: number;

  /**
   * Aggregate confidence from the lane-line samples used for the estimate.
   */
  confidence: number;
}

/**
 * Optional PID telemetry that examples and toolbox snippets can attach to output.debug.
 */
export interface PidDebugTerms {
  error: number;
  proportional: number;
  integral: number;
  derivative: number;
  output: number;
}

/**
 * Optional user-code debug payload. Extra keys are ignored by the simulator.
 */
export interface AutopilotDebug {
  lanePid?: PidDebugTerms;
  speedPid?: PidDebugTerms;
}

/**
 * Settings visible to simulation, sensors, and rendering.
 */
export interface PlaygroundSettings {
  seed: number;
  trafficDensity: number;
  startingSpeed: number;
  noisyLaneLines: boolean;
  noisyVehicles: boolean;
  actuatorVariation: boolean;
  debugOverlays: boolean;
  steerAssist: boolean;
  accelerateAssist: boolean;
}

export interface SanitizedAutopilotOutput {
  motor: number;
  steering: number;
  targetLane: number;
  debug?: AutopilotDebug;
  invalidFields: string[];
}

export type AutopilotFn = (input: AutopilotInput) => AutopilotOutput;
