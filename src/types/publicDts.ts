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

interface AutopilotInput {
  /** Simulation timestep in seconds. */
  dt: number;
  /** Ego vehicle state. */
  ego: EgoState;
  /** Nearby detected vehicles in ego-relative coordinates. */
  vehicles: VehicleDetection[];
  /** Detected lane-line samples in ego-relative coordinates. */
  laneLines: LaneLineDetections;
  /** Current target lane for the controller. */
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
  id: string;
  /** Lateral position relative to ego, in meters. Negative means left, positive means right. */
  relativeX: number;
  /** Longitudinal position relative to ego, in meters. Positive means ahead, negative means behind. */
  relativeY: number;
  relativeVx: number;
  relativeVy: number;
  width: number;
  length: number;
  confidence: number;
  /** Estimated lane index if known. */
  laneIndex?: number;
}

interface LaneLineSample {
  /** Lateral position relative to ego, in meters. */
  x: number;
  /** Longitudinal position relative to ego, in meters. */
  y: number;
  confidence: number;
}

interface LaneLineDetections {
  left: LaneLineSample[];
  right: LaneLineSample[];
  farLeft: LaneLineSample[];
  farRight: LaneLineSample[];
}

interface PidDebugTerms {
  error: number;
  proportional: number;
  integral: number;
  derivative: number;
  output: number;
}

interface AutopilotDebug {
  lanePid?: PidDebugTerms;
  speedPid?: PidDebugTerms;
}

declare function autopilot(input: AutopilotInput): AutopilotOutput;
`;
