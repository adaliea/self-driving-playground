export const publicAutopilotDts = `
interface AutopilotOutput {
  /**
   * Normalized motor command.
   * -1 means full braking/reverse force, 0 means coast, and 1 means full acceleration.
   * The simulator clamps invalid values to [-1, 1].
   */
  motor: number;

  /**
   * Normalized steering command.
   * -1 means maximum left steering, 0 means no steering correction, and 1 means maximum right steering.
   * The simulator clamps invalid values to [-1, 1].
   */
  steering: number;

  /**
   * Optional telemetry for UI display only. It is never trusted for physics.
   */
  debug?: AutopilotDebug;
}

/**
 * Sensor snapshot passed into the autopilot function each control tick.
 *
 * Use this object as the only source of truth for user code. Values are already
 * ego-relative where possible, so beginner controllers can work in meters and
 * seconds without reading simulator internals.
 */
interface AutopilotInput {
  /**
   * Simulation timestep in seconds.
   *
   * Use this for PID integral and derivative calculations instead of assuming a
   * frame rate.
   */
  dt: number;

  /**
   * Current ego vehicle state: speed, heading, and lane index.
   */
  ego: EgoState;

  /**
   * Stable, temporally filtered vehicle tracks in ego-relative coordinates.
   * Tracks predict through short raw-sensor dropouts.
   */
  vehicles: VehicleTrack[];

  /**
   * Raw vehicle observations before temporal tracking.
   * Measurements are noisy and may be absent during sensor dropouts.
   */
  vehicleMeasurements: VehicleMeasurement[];

  /**
   * Detected lane-line samples in ego-relative coordinates.
   *
   * These samples may be noisy or missing when lane-line noise is enabled.
   */
  laneLines: LaneLineDetections;
}

interface EgoState {
  /** Current forward speed in meters per second. */
  speed: number;
  /** Ego heading relative to the road/world frame, in radians. */
  heading: number;
  /** Ego world yaw rate in radians per second (positive turns right), including road curvature. */
  yawRate: number;
  /** Current lane index. For a 3-lane road, valid values are 0, 1, and 2. */
  laneIndex: number;
}

interface VehicleMeasurementUncertainty {
  /** One-standard-deviation lateral position uncertainty, in meters. */
  lateralPosition: number;
  /** One-standard-deviation longitudinal position uncertainty, in meters. */
  longitudinalPosition: number;
  /** One-standard-deviation heading uncertainty, in radians. */
  heading: number;
}

/**
 * One noisy vehicle observation before temporal tracking.
 */
interface VehicleMeasurement {
  /**
   * Association hint supplied by the playground detector.
   * A production detector may not provide a stable id before tracking.
   */
  id: string;
  /** Lateral position relative to ego, in meters. Negative means left, positive means right. */
  relativeX: number;
  /** Longitudinal position relative to ego, in meters. Positive means ahead, negative means behind. */
  relativeY: number;
  /** Observed vehicle yaw relative to ego heading, in radians. */
  relativeHeading: number;
  /** Observed vehicle width in meters. */
  width: number;
  /** Observed vehicle length in meters. */
  length: number;
  /** Measurement confidence from 0 to 1. */
  confidence: number;
  /** Estimated one-standard-deviation measurement error. */
  uncertainty: VehicleMeasurementUncertainty;
}

interface VehicleTrackUncertainty {
  /** One-standard-deviation lateral position uncertainty, in meters. */
  lateralPosition: number;
  /** One-standard-deviation longitudinal position uncertainty, in meters. */
  longitudinalPosition: number;
  /** One-standard-deviation lateral velocity uncertainty, in meters per second. */
  lateralVelocity: number;
  /** One-standard-deviation longitudinal velocity uncertainty, in meters per second. */
  longitudinalVelocity: number;
  /** One-standard-deviation heading uncertainty, in radians. */
  heading: number;
}

/**
 * A temporally filtered and predicted vehicle estimate.
 */
interface VehicleTrack {
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
  /** Seconds since this track was initialized. */
  age: number;
  /** Seconds since the last raw observation updated this track. */
  timeSinceMeasurement: number;
  /** True when this frame is a prediction with no matching raw observation. */
  isPredicted: boolean;
  uncertainty: VehicleTrackUncertainty;
}

/** @deprecated Prefer VehicleTrack in new controller code. */
type VehicleDetection = VehicleTrack;

interface LaneLineSample {
  /** Lateral position relative to ego, in meters. */
  x: number;
  /** Longitudinal position relative to ego, in meters. */
  y: number;
  /**
   * Sample confidence from 0 to 1.
   */
  confidence: number;
}

/**
 * Lane-line detections around the current ego lane.
 */
interface LaneLineDetections {
  /**
   * Left boundary of the current lane.
   */
  left: LaneLineSample[];

  /**
   * Right boundary of the current lane.
   */
  right: LaneLineSample[];

  /**
   * Boundary one lane farther left when available.
   */
  farLeft: LaneLineSample[];

  /**
   * Boundary one lane farther right when available.
   */
  farRight: LaneLineSample[];
}

/**
 * Interpreted lane geometry returned by analyzeLaneRegression.
 */
interface LaneAnalysis {
  /**
   * Estimated lateral offset from the target lane center, in meters.
   * Positive means the lane center is to the right of ego.
   */
  centerOffset: number;

  /**
   * Estimated lane heading error in radians, at ego for local regression or ahead for preview.
   */
  heading: number;

  /**
   * Estimated signed lane curvature, at ego for local regression or ahead for preview.
   */
  curvature: number;

  /**
   * Aggregate confidence from the lane-line samples used for the estimate.
   */
  confidence: number;
}

/**
 * PID telemetry values for the UI.
 *
 * These values are display-only. They do not affect simulator physics.
 */
interface PidDebugTerms {
  /**
   * Current control error.
   */
  error: number;

  /**
   * Proportional term: immediate response to current error.
   */
  proportional: number;

  /**
   * Integral term: accumulated response to persistent error.
   */
  integral: number;

  /**
   * Derivative term: damping response to the rate of error change.
   */
  derivative: number;

  /**
   * Final PID output after combining terms and applying limits.
   */
  output: number;
}

/**
 * Optional debug payload returned as AutopilotOutput.debug.
 */
interface AutopilotDebug {
  /**
   * PID telemetry for lane keeping.
   */
  lanePid?: PidDebugTerms;

  /**
   * PID telemetry for speed control.
   */
  speedPid?: PidDebugTerms;
}

/**
 * Built-in lane interpretation helper available to user code.
 *
 * By default, it fits a weighted quadratic through the nearest 3–21 meters
 * and estimates center offset, heading, and curvature at ego for steering.
 * Pass 'preview' as the third argument for the original longer forward fit
 * (5–56 meters), useful for speed planning. Pass -1 or 1 as relativeTargetLane
 * to analyze an adjacent lane, for example the lane returned by a lane chooser
 * during a lane change.
 */
declare function analyzeLaneRegression(
  /** Lane-line samples around the ego lane. */
  laneLines: LaneLineDetections,
  /**
   * Target lane relative to ego.laneIndex.
   * Use -1 for left adjacent lane, 0 for current lane, and 1 for right adjacent lane.
   */
  relativeTargetLane?: number,
  /** Local steering geometry (default), or a longer speed-planning preview. */
  mode?: 'local' | 'preview'
): LaneAnalysis;

/**
 * Plots a value in the Telemetry graphs, one point per autopilot call.
 *
 * Call it with the same name every tick, for example
 * graph('lane offset', lane.centerOffset, 'm'). Series with the same unit share
 * a y-axis; without a unit each series gets its own scale. Booleans plot as 0/1,
 * and non-finite values are skipped. Returns value unchanged, so it can wrap an
 * expression inline. Graphing never affects the simulation.
 */
declare function graph<T extends number | boolean>(
  /** Series name shown in the graph picker (up to 60 characters). */
  name: string,
  value: T,
  /** Optional unit label, such as 'm' or 'rad'. Series with the same unit share an axis. */
  unit?: string
): T;

/**
 * Main controller entry point called once per simulation control tick.
 *
 * Keep persistent controller state, such as PID objects, outside this function
 * so it survives between frames.
 *
 * @param input Current ego-relative sensor snapshot.
 * @returns Normalized motor and steering command.
 */
declare function autopilot(input: AutopilotInput): AutopilotOutput;
`;
