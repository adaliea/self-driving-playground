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
   * Optional requested lane index. For the ego MVP this usually matches input.targetLane.
   */
  targetLane?: number;

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
   * Nearby detected vehicles in ego-relative coordinates.
   *
   * Positive relativeY means ahead. Negative relativeX means left.
   */
  vehicles: VehicleDetection[];

  /**
   * Detected lane-line samples in ego-relative coordinates.
   *
   * These samples may be noisy or missing when lane-line noise is enabled.
   */
  laneLines: LaneLineDetections;

  /**
   * Current target lane for the controller.
   *
   * For the ego MVP this usually matches ego.laneIndex. Traffic controllers can
   * use a different value while changing lanes.
   */
  targetLane: number;
}

interface EgoState {
  /** Current forward speed in meters per second. */
  speed: number;
  /** Ego heading relative to the road/world frame, in radians. */
  heading: number;
  /** Current lane index. For a 3-lane road, valid values are 0, 1, and 2. */
  laneIndex: number;
}

interface VehicleDetection {
  /**
   * Stable id for this detected vehicle.
   */
  id: string;
  /** Lateral position relative to ego, in meters. Negative means left, positive means right. */
  relativeX: number;
  /** Longitudinal position relative to ego, in meters. Positive means ahead, negative means behind. */
  relativeY: number;
  /**
   * Lateral relative velocity estimate in meters per second.
   */
  relativeVx: number;

  /**
   * Longitudinal relative velocity estimate in meters per second.
   *
   * Negative means the detected vehicle is slower than ego.
   */
  relativeVy: number;

  /**
   * Detected vehicle yaw relative to ego heading, in radians.
   * Positive angles turn toward ego's right.
   */
  relativeHeading: number;

  /**
   * Estimated vehicle width in meters.
   */
  width: number;

  /**
   * Estimated vehicle length in meters.
   */
  length: number;

  /**
   * Detection confidence from 0 to 1.
   */
  confidence: number;
  /** Estimated lane index if known. */
  laneIndex?: number;
}

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
 * It fits a weighted quadratic regression through forward lane-center samples
 * and returns center offset, heading, curvature, and confidence. Pass
 * input.targetLane - input.ego.laneIndex as relativeTargetLane to analyze an
 * adjacent target lane during lane-change experiments.
 */
declare function analyzeLaneRegression(
  /** Lane-line samples around the ego lane. */
  laneLines: LaneLineDetections,
  /**
   * Target lane relative to ego.laneIndex.
   * Use -1 for left adjacent lane, 0 for current lane, and 1 for right adjacent lane.
   */
  relativeTargetLane?: number
): LaneAnalysis;

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
