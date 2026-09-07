export const clampImplementation = `/**
 * Constrains a value to the inclusive range between min and max.
 *
 * Use this before returning motor or steering commands so temporary controller
 * spikes cannot exceed the simulator's normalized command range.
 *
 * @param value Number to constrain.
 * @param min Lowest allowed output.
 * @param max Highest allowed output.
 * @returns The value, clipped to the provided range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}`;

export const vehicleTrackerImplementation = `/**
 * Tuning options for the educational constant-velocity vehicle tracker.
 */
interface VehicleTrackerOptions {
  /** Seconds to publish predictions without a matching measurement. Default: 0.42. */
  maxPredictionTime?: number;
  /** Expected relative acceleration in meters per second squared. Default: 3.2. */
  accelerationStdDev?: number;
}

/** Stateful tracker returned by createVehicleTracker. */
interface VehicleTracker {
  /** Predicts existing tracks, incorporates this frame's measurements, and returns current tracks. */
  update(measurements: VehicleMeasurement[], dt: number): VehicleTrack[];
  /** Removes all track history. */
  reset(): void;
}

interface VehicleTrackerAxisState {
  position: number;
  velocity: number;
  p00: number;
  p01: number;
  p11: number;
}

interface VehicleTrackerState {
  id: string;
  x: VehicleTrackerAxisState;
  y: VehicleTrackerAxisState;
  heading: number;
  headingVariance: number;
  width: number;
  length: number;
  confidence: number;
  laneIndex?: number;
  age: number;
  timeSinceMeasurement: number;
  isPredicted: boolean;
}

/**
 * Creates a small constant-velocity Kalman tracker for input.vehicleMeasurements.
 *
 * Keep the returned object outside autopilot(input) so its state survives from
 * one control tick to the next. The playground supplies stable measurement ids
 * to keep this lesson focused on filtering; production trackers also need data
 * association.
 */
function createVehicleTracker(options: VehicleTrackerOptions = {}): VehicleTracker {
  const states = new Map<string, VehicleTrackerState>();
  const maxPredictionTime = options.maxPredictionTime ?? 0.42;
  const accelerationStdDev = options.accelerationStdDev ?? 3.2;

  return {
    update(measurements: VehicleMeasurement[], dt: number): VehicleTrack[] {
      const safeDt = clamp(dt, 0, 0.25);

      for (const state of states.values()) {
        predictVehicleTrackerAxis(state.x, safeDt, accelerationStdDev);
        predictVehicleTrackerAxis(state.y, safeDt, accelerationStdDev);
        state.headingVariance += Math.pow(5 * Math.PI / 180, 2) * safeDt;
        state.age += safeDt;
        state.timeSinceMeasurement += safeDt;
        state.isPredicted = true;
        state.confidence *= Math.exp(-safeDt / 0.34);
      }

      for (const measurement of measurements) {
        let state = states.get(measurement.id);
        if (!state) {
          state = initializeVehicleTrackerState(measurement, safeDt);
          states.set(measurement.id, state);
          continue;
        }

        updateVehicleTrackerAxis(
          state.x,
          measurement.relativeX,
          Math.pow(measurement.uncertainty.lateralPosition, 2)
        );
        updateVehicleTrackerAxis(
          state.y,
          measurement.relativeY,
          Math.pow(measurement.uncertainty.longitudinalPosition, 2)
        );

        const headingNoise = Math.max(Math.pow(measurement.uncertainty.heading, 2), 1e-6);
        const headingGain = state.headingVariance / (state.headingVariance + headingNoise);
        state.heading = normalizeTrackerAngle(
          state.heading + headingGain * normalizeTrackerAngle(measurement.relativeHeading - state.heading)
        );
        state.headingVariance = Math.max(1e-9, (1 - headingGain) * state.headingVariance);
        state.width += (measurement.width - state.width) * 0.28;
        state.length += (measurement.length - state.length) * 0.22;
        state.confidence = clamp(state.confidence * 0.58 + measurement.confidence * 0.42, 0, 1);
        state.laneIndex = measurement.laneIndex;
        state.timeSinceMeasurement = 0;
        state.isPredicted = false;
      }

      for (const [id, state] of states) {
        if (state.timeSinceMeasurement > maxPredictionTime) states.delete(id);
      }

      return Array.from(states.values())
        .map(vehicleTrackFromState)
        .sort((a, b) => a.relativeY - b.relativeY);
    },

    reset(): void {
      states.clear();
    },
  };
}

function initializeVehicleTrackerState(
  measurement: VehicleMeasurement,
  dt: number
): VehicleTrackerState {
  return {
    id: measurement.id,
    x: initializeVehicleTrackerAxis(
      measurement.relativeX,
      Math.pow(measurement.uncertainty.lateralPosition, 2)
    ),
    y: initializeVehicleTrackerAxis(
      measurement.relativeY,
      Math.pow(measurement.uncertainty.longitudinalPosition, 2)
    ),
    heading: measurement.relativeHeading,
    headingVariance: Math.max(Math.pow(measurement.uncertainty.heading, 2), 1e-6),
    width: measurement.width,
    length: measurement.length,
    confidence: measurement.confidence,
    laneIndex: measurement.laneIndex,
    age: dt,
    timeSinceMeasurement: 0,
    isPredicted: false,
  };
}

function initializeVehicleTrackerAxis(
  position: number,
  positionVariance: number
): VehicleTrackerAxisState {
  return {
    position,
    velocity: 0,
    p00: Math.max(positionVariance, 1e-6),
    p01: 0,
    // One box does not reveal velocity, so the initial velocity covariance is intentionally high.
    p11: 36,
  };
}

function predictVehicleTrackerAxis(
  axis: VehicleTrackerAxisState,
  dt: number,
  accelerationStdDev: number
): void {
  const accelerationVariance = Math.pow(accelerationStdDev, 2);
  const oldP01 = axis.p01;
  const oldP11 = axis.p11;
  axis.position += axis.velocity * dt;
  axis.p00 += 2 * dt * oldP01 + Math.pow(dt, 2) * oldP11 +
    0.25 * Math.pow(dt, 4) * accelerationVariance;
  axis.p01 += dt * oldP11 + 0.5 * Math.pow(dt, 3) * accelerationVariance;
  axis.p11 += Math.pow(dt, 2) * accelerationVariance;
}

function updateVehicleTrackerAxis(
  axis: VehicleTrackerAxisState,
  measurement: number,
  measurementVariance: number
): void {
  const innovationVariance = axis.p00 + Math.max(measurementVariance, 1e-6);
  const positionGain = axis.p00 / innovationVariance;
  const velocityGain = axis.p01 / innovationVariance;
  const innovation = measurement - axis.position;
  const oldP00 = axis.p00;
  const oldP01 = axis.p01;
  const oldP11 = axis.p11;
  axis.position += positionGain * innovation;
  axis.velocity += velocityGain * innovation;
  axis.p00 = Math.max(1e-9, (1 - positionGain) * oldP00);
  axis.p01 = (1 - positionGain) * oldP01;
  axis.p11 = Math.max(1e-9, oldP11 - velocityGain * oldP01);
}

function vehicleTrackFromState(state: VehicleTrackerState): VehicleTrack {
  return {
    id: state.id,
    relativeX: state.x.position,
    relativeY: state.y.position,
    relativeVx: state.x.velocity,
    relativeVy: state.y.velocity,
    relativeHeading: state.heading,
    width: state.width,
    length: state.length,
    confidence: clamp(state.confidence, 0, 1),
    laneIndex: state.laneIndex,
    age: state.age,
    timeSinceMeasurement: state.timeSinceMeasurement,
    isPredicted: state.isPredicted,
    uncertainty: {
      lateralPosition: Math.sqrt(state.x.p00),
      longitudinalPosition: Math.sqrt(state.y.p00),
      lateralVelocity: Math.sqrt(state.x.p11),
      longitudinalVelocity: Math.sqrt(state.y.p11),
      heading: Math.sqrt(state.headingVariance),
    },
  };
}

function normalizeTrackerAngle(angle: number): number {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}`;

export const vehicleFilteringImplementation = `/**
 * Returns detections whose estimated lane matches laneIndex.
 *
 * @param vehicles Nearby vehicle detections from AutopilotInput.vehicles.
 * @param laneIndex Lane to keep.
 * @returns Vehicles whose laneIndex equals the requested lane.
 */
function filterVehiclesInLane(
  vehicles: VehicleDetection[],
  laneIndex: number
): VehicleDetection[] {
  return vehicles.filter(vehicle => vehicle.laneIndex === laneIndex);
}

/**
 * Finds the nearest detected vehicle ahead in a lane.
 *
 * @param vehicles Nearby vehicle detections from AutopilotInput.vehicles.
 * @param laneIndex Lane to search.
 * @returns The closest vehicle with positive relativeY, or undefined when the lane is clear.
 */
function closestVehicleAhead(
  vehicles: VehicleDetection[],
  laneIndex: number
): VehicleDetection | undefined {
  return filterVehiclesInLane(vehicles, laneIndex)
    .filter(vehicle => vehicle.relativeY > 0)
    .sort((a, b) => a.relativeY - b.relativeY)[0];
}`;

export const pidControllerImplementation = `/**
 * Proportional, integral, and derivative gains for a PID controller.
 */
interface PidGains {
  /**
   * Proportional gain.
   *
   * Multiplies the current error. Higher kp reacts faster to lane or speed
   * error, but too much can cause oscillation.
   */
  kp: number;

  /**
   * Integral gain.
   *
   * Multiplies accumulated error over time. Higher ki removes persistent bias,
   * but too much can wind up and keep pushing after the error changes sign.
   */
  ki: number;

  /**
   * Derivative gain.
   *
   * Multiplies the rate of error change. Higher kd damps fast changes and can
   * reduce overshoot, but too much can make noisy inputs twitchy.
   */
  kd: number;
}

/**
 * PID tuning and output limits.
 */
interface PidControllerOptions extends PidGains {
  /**
   * Minimum value returned by update.
   *
   * Use -1 for normalized motor or steering commands.
   */
  outputMin?: number;

  /**
   * Maximum value returned by update.
   *
   * Use 1 for normalized motor or steering commands.
   */
  outputMax?: number;

  /**
   * Minimum stored integral error before ki is applied.
   *
   * This limits windup when the controller spends a long time saturated.
   */
  integralMin?: number;

  /**
   * Maximum stored integral error before ki is applied.
   *
   * This limits windup when the controller spends a long time saturated.
   */
  integralMax?: number;
}

/**
 * Stateful PID controller returned by createPidController.
 */
interface PidController {
  /**
   * Advances the controller by one control tick.
   *
   * @param error Desired value minus measured value for speed, or lane error for steering.
   * @param dt Time step in seconds. Use input.dt from AutopilotInput.
   * @returns Clamped controller output.
   */
  update(error: number, dt: number): number;

  /**
   * Returns the latest PID terms for telemetry.
   *
   * The playground displays these terms automatically using the controller variable name.
   */
  getDebug(): PidDebugTerms;

  /**
   * Clears accumulated integral and derivative history.
   *
   * Call this after a mode change or large setpoint jump if old controller
   * history should not influence the next update.
   */
  reset(): void;
}

/**
 * Creates a stateful PID controller.
 *
 * Keep the returned object outside autopilot(input) when you want integral and
 * derivative history to persist across frames.
 *
 * @param options Gains and optional output/integral limits.
 * @returns A controller with update, getDebug, and reset methods.
 */
function createPidController(options: PidControllerOptions): PidController {
  let integral = 0;
  let previousError = 0;
  let hasPreviousError = false;
  let lastTerms: PidDebugTerms = {
    error: 0,
    proportional: 0,
    integral: 0,
    derivative: 0,
    output: 0,
  };

  return {
    /**
     * Advances the controller by one control tick.
     *
     * @param error Desired value minus measured value for speed, or lane error for steering.
     * @param dt Time step in seconds. Use input.dt from AutopilotInput.
     * @returns Clamped controller output.
     */
    update(error: number, dt: number): number {
      if (dt <= 0) return 0;

      integral += error * dt;

      if (options.integralMin !== undefined || options.integralMax !== undefined) {
        integral = clamp(
          integral,
          options.integralMin ?? Number.NEGATIVE_INFINITY,
          options.integralMax ?? Number.POSITIVE_INFINITY
        );
      }

      const derivative = hasPreviousError
        ? (error - previousError) / dt
        : 0;

      previousError = error;
      hasPreviousError = true;

      const proportionalTerm = options.kp * error;
      const integralTerm = options.ki * integral;
      const derivativeTerm = options.kd * derivative;
      const unclampedOutput = proportionalTerm + integralTerm + derivativeTerm;
      const output = clamp(
        unclampedOutput,
        options.outputMin ?? Number.NEGATIVE_INFINITY,
        options.outputMax ?? Number.POSITIVE_INFINITY
      );

      lastTerms = {
        error,
        proportional: proportionalTerm,
        integral: integralTerm,
        derivative: derivativeTerm,
        output,
      };

      return output;
    },

    /**
     * Returns the latest PID terms for telemetry.
     */
    getDebug(): PidDebugTerms {
      return lastTerms;
    },

    /**
     * Clears accumulated integral and derivative history.
     */
    reset(): void {
      integral = 0;
      previousError = 0;
      hasPreviousError = false;
      lastTerms = {
        error: 0,
        proportional: 0,
        integral: 0,
        derivative: 0,
        output: 0,
      };
    },
  };
}`;

export const laneInterpretationImplementation = `/**
 * Estimates lane center offset, heading, curvature, and confidence.
 *
 * This simpler helper samples the current lane boundaries at near, mid, and far
 * lookahead points. For sharper curves or lane-change experiments, try
 * analyzeLaneRegression or analyzeTargetLane instead.
 *
 * @param laneLines Detected lane-line samples around the ego lane.
 * @returns Interpreted lane geometry for steering control.
 */
function analyzeLane(laneLines: LaneLineDetections): LaneAnalysis {
  const centerAt = (y: number) => {
    const left = sampleLineAtY(laneLines.left, y);
    const right = sampleLineAtY(laneLines.right, y);

    if (left && right) {
      return {
        x: (left.x + right.x) / 2,
        confidence: (left.confidence + right.confidence) / 2,
      };
    }

    if (left) return { x: left.x + 1.85, confidence: left.confidence * 0.5 };
    if (right) return { x: right.x - 1.85, confidence: right.confidence * 0.5 };
    return { x: 0, confidence: 0 };
  };

  const near = centerAt(12);
  const mid = centerAt(34);
  const far = centerAt(62);

  return {
    centerOffset: near.x,
    heading: Math.atan2(far.x - near.x, 50),
    curvature: ((far.x - mid.x) - (mid.x - near.x)) / 900,
    confidence: (near.confidence + mid.confidence + far.confidence) / 3,
  };
}

/**
 * Interpolates a lane-line sample at a forward distance.
 *
 * @param samples Lane-line samples sorted or unsorted by y.
 * @param y Forward distance in meters from the ego vehicle.
 * @returns An interpolated sample, or undefined when no samples are available.
 */
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
}`;

export const accelerationFeedforwardImplementation = `/**
 * Estimates a motor command before PID feedback is added.
 *
 * Feedforward gives the speed controller a rough starting point for acceleration
 * and drag, so the PID loop has less steady error to correct.
 *
 * @param targetSpeed Desired speed in meters per second.
 * @param currentSpeed Current ego speed in meters per second.
 * @returns Normalized motor estimate, clamped to [-1, 1].
 */
function accelerationFeedforward(
  targetSpeed: number,
  currentSpeed: number
): number {
  const speedError = targetSpeed - currentSpeed;
  const dragCompensation = 0.00048 * currentSpeed * currentSpeed + 0.004 * currentSpeed;
  const requestedAccel = speedError * 0.09 + dragCompensation;
  return clamp(requestedAccel, -1, 1);
}`;

export const curveRegressionImplementation = `/**
 * Fits the nearest 3–21 meters of the target lane for steering by default.
 * Use preview mode for the longer forward fit when planning speed.
 *
 * @param input Current sensor snapshot.
 * @param mode Local steering geometry (default), or a longer speed-planning preview.
 * @returns Lane geometry for input.targetLane relative to the ego lane.
 */
function analyzeTargetLane(input: AutopilotInput, mode: 'local' | 'preview' = 'local'): LaneAnalysis {
  const relativeTargetLane = input.targetLane - input.ego.laneIndex;
  return analyzeLaneRegression(input.laneLines, relativeTargetLane, mode);
}

/**
 * Converts lane curvature into a steering feedforward term.
 *
 * Use this alongside PID feedback so the controller begins turning before a
 * curve creates a large lateral error.
 *
 * @param lane Interpreted lane geometry.
 * @param speed Ego speed in meters per second.
 * @returns Steering feedforward clamped to [-0.4, 0.4].
 */
function curvatureSteeringFeedforward(
  lane: LaneAnalysis,
  speed: number
): number {
  const steeringScale = Math.max(0.08, Math.min(1, speed / 22));
  const feedforward = (lane.curvature * speed) / Math.max(0.08, 0.68 * steeringScale);
  return clamp(feedforward, -0.4, 0.4);
}`;

export const adaptiveCruiseImplementation = `/**
 * Reduces target speed when following another vehicle too closely.
 *
 * @param input Current sensor snapshot.
 * @param freeRoadSpeed Desired speed when there is no close lead vehicle.
 * @returns A target speed in meters per second.
 */
function adaptiveCruiseTargetSpeed(
  input: AutopilotInput,
  freeRoadSpeed: number
): number {
  const lead = closestVehicleAhead(input.vehicles, input.ego.laneIndex);
  if (!lead) return freeRoadSpeed;

  const leadSpeed = input.ego.speed + lead.relativeVy;
  const targetGap = 10 + input.ego.speed * 1.25;
  const gapError = lead.relativeY - targetGap;

  if (gapError > 18) return freeRoadSpeed;
  return Math.max(4, Math.min(freeRoadSpeed, leadSpeed + gapError * 0.35));
}`;

export const toolboxLibrarySource = [
  clampImplementation,
  vehicleFilteringImplementation,
  pidControllerImplementation,
  laneInterpretationImplementation,
  accelerationFeedforwardImplementation,
  curveRegressionImplementation,
  adaptiveCruiseImplementation,
  vehicleTrackerImplementation,
].join('\n\n');
