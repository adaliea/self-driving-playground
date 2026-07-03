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
   * Nearby detected vehicles in ego-relative coordinates.
   */
  vehicles: VehicleDetection[];

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
 * A nearby vehicle detection in ego-relative coordinates.
 */
export interface VehicleDetection {
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

  relativeVx: number;
  relativeVy: number;

  width: number;
  length: number;
  confidence: number;

  /**
   * Estimated lane index if known.
   */
  laneIndex?: number;
}

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
