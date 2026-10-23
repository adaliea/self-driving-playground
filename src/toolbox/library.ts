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
  /**
   * Predicts existing tracks, incorporates this frame's measurements, and returns current tracks.
   *
   * Pass input.ego so prediction can undo ego motion: tracks live in the ego
   * frame, which rotates whenever ego turns (lane changes and road curves), and
   * without ego.yawRate a constant-velocity model mistakes that rotation for
   * every other car swinging sideways.
   */
  update(measurements: VehicleMeasurement[], dt: number, ego?: EgoState): VehicleTrack[];
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

/** How the ego frame moved since the previous update. */
interface VehicleTrackerEgoMotion {
  dt: number;
  /** World yaw change of ego over the tick, in radians. */
  yawDelta: number;
  /** Road curvature in 1/m (positive curves right), so other cars can follow the curve too. */
  roadCurvature: number;
  previousSpeed: number;
  speed: number;
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
  let previousEgo: EgoState | undefined;
  let roadCurvature = 0;

  return {
    update(measurements: VehicleMeasurement[], dt: number, ego?: EgoState): VehicleTrack[] {
      const safeDt = clamp(dt, 0, 0.25);
      let egoMotion: VehicleTrackerEgoMotion | undefined;
      if (ego) {
        // Physical yaw rates stay under 1 rad/s; anything faster is a reset.
        const yawDelta = Math.abs(ego.yawRate) < 3 ? ego.yawRate * safeDt : 0;
        const previousSpeed = previousEgo ? previousEgo.speed : ego.speed;
        // ego.heading is road-relative, so yaw it doesn't explain is the road curving.
        const roadDistance = 0.5 * (previousSpeed + ego.speed) * safeDt * Math.cos(ego.heading);
        if (previousEgo && roadDistance > 0.05) {
          const roadTurn = yawDelta - normalizeTrackerAngle(ego.heading - previousEgo.heading);
          roadCurvature = clamp(roadTurn / roadDistance, -0.04, 0.04);
        }
        egoMotion = { dt: safeDt, yawDelta, roadCurvature, previousSpeed, speed: ego.speed };
      }
      previousEgo = ego && { ...ego };

      for (const state of states.values()) {
        predictVehicleTrackerAxis(state.x, safeDt, accelerationStdDev);
        predictVehicleTrackerAxis(state.y, safeDt, accelerationStdDev);
        if (egoMotion) compensateVehicleTrackerEgoMotion(state, egoMotion);
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
      previousEgo = undefined;
      roadCurvature = 0;
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

/**
 * Moves a freshly predicted track from last tick's ego frame into this tick's.
 *
 * The constant-velocity step assumed ego drove straight at its old speed. Here
 * we use where ego actually went (a short arc) and rotate position by the ego
 * yaw change. Velocity is the target's world velocity (relative velocity plus
 * ego speed) minus ego's speed: the world part rotates with the frame, less
 * the turn the target makes by following the road curve, then ego's new speed
 * is subtracted. Each covariance block is rotated too, keeping per-axis
 * variances so x and y stay separate filters.
 */
function compensateVehicleTrackerEgoMotion(
  state: VehicleTrackerState,
  ego: VehicleTrackerEgoMotion
): void {
  const cos = Math.cos(ego.yawDelta);
  const sin = Math.sin(ego.yawDelta);
  const egoDistance = 0.5 * (ego.previousSpeed + ego.speed) * ego.dt;
  const x = state.x.position - egoDistance * Math.sin(ego.yawDelta / 2);
  const y = state.y.position + ego.previousSpeed * ego.dt - egoDistance * Math.cos(ego.yawDelta / 2);
  state.x.position = x * cos - y * sin;
  state.y.position = x * sin + y * cos;

  const worldVx = state.x.velocity;
  const worldVy = state.y.velocity + ego.previousSpeed;
  const targetTurn = ego.roadCurvature * worldVy * ego.dt;
  const vCos = Math.cos(ego.yawDelta - targetTurn);
  const vSin = Math.sin(ego.yawDelta - targetTurn);
  state.x.velocity = worldVx * vCos - worldVy * vSin;
  state.y.velocity = worldVx * vSin + worldVy * vCos - ego.speed;
  state.heading = normalizeTrackerAngle(state.heading - ego.yawDelta + targetTurn);

  const x00 = state.x.p00, x01 = state.x.p01, x11 = state.x.p11;
  const y00 = state.y.p00, y01 = state.y.p01, y11 = state.y.p11;
  state.x.p00 = cos * cos * x00 + sin * sin * y00;
  state.x.p01 = cos * vCos * x01 + sin * vSin * y01;
  state.x.p11 = vCos * vCos * x11 + vSin * vSin * y11;
  state.y.p00 = sin * sin * x00 + cos * cos * y00;
  state.y.p01 = sin * vSin * x01 + cos * vCos * y01;
  state.y.p11 = vSin * vSin * x11 + vCos * vCos * y11;
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

export const vehicleFilteringImplementation = `/** Nominal lane width in meters, used when a lane line isn't detected. */
const LANE_WIDTH = 3.7;

/**
 * Checks whether any part of a vehicle's bounding box overlaps a lane.
 *
 * Lane boundaries come from the detected lane lines at the vehicle's forward
 * distance. The box is rotated into the lane's direction, so a car straddling a
 * line counts as being in both lanes.
 *
 * @param vehicle Vehicle track or measurement in ego-relative coordinates.
 * @param laneLines Detected lane lines from AutopilotInput.laneLines.
 * @param relativeLane Lane to test relative to ego: -1 left, 0 ego's lane, 1 right.
 * @returns True when the vehicle's footprint overlaps the lane.
 */
function isVehicleInLane(
  vehicle: VehicleTrack | VehicleMeasurement,
  laneLines: LaneLineDetections,
  relativeLane = 0
): boolean {
  const y = vehicle.relativeY;
  const left = laneBoundaryXAtY(laneLines, relativeLane, y);
  const right = laneBoundaryXAtY(laneLines, relativeLane + 1, y);
  const leftAhead = laneBoundaryXAtY(laneLines, relativeLane, y + 1);
  const rightAhead = laneBoundaryXAtY(laneLines, relativeLane + 1, y + 1);
  // Compare in the lane's own frame so a car aligned with a curve ahead is not
  // widened by its yaw relative to ego.
  const laneHeading = Math.atan((leftAhead + rightAhead - left - right) / 2);
  const yaw = vehicle.relativeHeading - laneHeading;
  const halfExtent =
    (Math.abs(Math.cos(yaw)) * vehicle.width + Math.abs(Math.sin(yaw)) * vehicle.length) / 2;
  const cosHeading = Math.cos(laneHeading);
  const offsetFromLeft = (vehicle.relativeX - left) * cosHeading;
  return offsetFromLeft - halfExtent < (right - left) * cosHeading && offsetFromLeft + halfExtent > 0;
}

/**
 * Returns vehicles whose bounding box overlaps a lane.
 *
 * @param vehicles Nearby vehicles from AutopilotInput.vehicles.
 * @param laneLines Detected lane lines from AutopilotInput.laneLines.
 * @param relativeLane Lane to keep relative to ego: -1 left, 0 ego's lane, 1 right.
 * @returns Vehicles with any part of their footprint in the lane.
 */
function filterVehiclesInLane(
  vehicles: VehicleDetection[],
  laneLines: LaneLineDetections,
  relativeLane = 0
): VehicleDetection[] {
  return vehicles.filter(vehicle => isVehicleInLane(vehicle, laneLines, relativeLane));
}

/**
 * Finds the nearest vehicle ahead whose bounding box overlaps a lane.
 *
 * @param vehicles Nearby vehicles from AutopilotInput.vehicles.
 * @param laneLines Detected lane lines from AutopilotInput.laneLines.
 * @param relativeLane Lane to search relative to ego: -1 left, 0 ego's lane, 1 right.
 * @returns The closest vehicle with positive relativeY, or undefined when the lane is clear.
 */
function closestVehicleAhead(
  vehicles: VehicleDetection[],
  laneLines: LaneLineDetections,
  relativeLane = 0
): VehicleDetection | undefined {
  return filterVehiclesInLane(vehicles, laneLines, relativeLane)
    .filter(vehicle => vehicle.relativeY > 0)
    .sort((a, b) => a.relativeY - b.relativeY)[0];
}

/**
 * Lateral position of a lane boundary at a forward distance.
 *
 * Boundary 0 is ego's left line and 1 its right line (-1 far left, 2 far right).
 * Missing lines are inferred from the nearest detected one, or from a nominal
 * lane centered on ego when nothing is detected.
 */
function laneBoundaryXAtY(laneLines: LaneLineDetections, boundary: number, y: number): number {
  const detected: Array<[number, LaneLineSample[]]> = [
    [-1, laneLines.farLeft],
    [0, laneLines.left],
    [1, laneLines.right],
    [2, laneLines.farRight],
  ];
  let nearest: [number, number] | undefined;
  for (const [index, samples] of detected) {
    if (nearest && Math.abs(index - boundary) >= Math.abs(nearest[0] - boundary)) continue;
    const x = laneLineXAtY(samples, y);
    if (x !== undefined) nearest = [index, x];
  }
  if (!nearest) return (boundary - 0.5) * LANE_WIDTH;
  return nearest[1] + (boundary - nearest[0]) * LANE_WIDTH;
}

/**
 * Interpolates a lane line at a forward distance, extending its end segments
 * linearly beyond the detected span.
 */
function laneLineXAtY(samples: LaneLineSample[], y: number): number | undefined {
  if (samples.length === 0) return undefined;
  let before: LaneLineSample | undefined;
  let after: LaneLineSample | undefined;
  for (const sample of samples) {
    if (sample.y <= y && (!before || sample.y > before.y)) before = sample;
    if (sample.y >= y && (!after || sample.y < after.y)) after = sample;
  }
  if (before && after) {
    if (after.y === before.y) return before.x;
    return before.x + ((after.x - before.x) * (y - before.y)) / (after.y - before.y);
  }

  // Pair the end sample with the nearest one at least 10 m away (or the
  // farthest available) so sample jitter doesn't dominate the slope.
  const end = (before ?? after)!;
  let anchor = end;
  for (const sample of samples) {
    const distance = Math.abs(sample.y - end.y);
    const anchorDistance = Math.abs(anchor.y - end.y);
    const closerToBaseline = anchorDistance < 10
      ? distance > anchorDistance
      : distance >= 10 && distance < anchorDistance;
    if (closerToBaseline) anchor = sample;
  }
  if (anchor.y === end.y) return end.x;
  return end.x + ((end.x - anchor.x) * (y - end.y)) / (end.y - anchor.y);
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
 * analyzeLaneRegression instead.
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
 * Pass the lane you are moving into as relativeLane during a lane change and
 * the closer lead of the two lanes is followed, so the change doesn't run into
 * the new lane's traffic.
 *
 * @param input Current sensor snapshot.
 * @param freeRoadSpeed Desired speed when there is no close lead vehicle.
 * @param relativeLane Lane being moved into, relative to ego: -1 left, 0 none, 1 right.
 * @returns A target speed in meters per second.
 */
function adaptiveCruiseTargetSpeed(
  input: AutopilotInput,
  freeRoadSpeed: number,
  relativeLane = 0
): number {
  const leads = [closestVehicleAhead(input.vehicles, input.laneLines)];
  if (relativeLane !== 0) leads.push(closestVehicleAhead(input.vehicles, input.laneLines, relativeLane));
  const lead = leads
    .filter((vehicle): vehicle is VehicleDetection => vehicle !== undefined)
    .sort((a, b) => a.relativeY - b.relativeY)[0];
  if (!lead) return freeRoadSpeed;

  const leadSpeed = input.ego.speed + lead.relativeVy;
  const targetGap = 10 + input.ego.speed * 1.25;
  const gapError = lead.relativeY - targetGap;

  if (gapError > 18) return freeRoadSpeed;
  return Math.max(4, Math.min(freeRoadSpeed, leadSpeed + gapError * 0.35));
}`;

export const laneSelectionImplementation = `/**
 * Tuning options for createLaneChooser.
 */
interface LaneChooserOptions {
  /** Minimum speed gain, in m/s, an adjacent lane must offer before switching. Default: 2. */
  minSpeedGain?: number;
  /** Meters ahead to look for the vehicle that sets each lane's speed. Default: 60. */
  lookahead?: number;
  /** Speed in m/s assumed for a lane with nobody ahead within the lookahead. Set it to your cruise speed. Default: 29. */
  openLaneSpeed?: number;
  /** Center-to-center clearance in meters needed ahead in the new lane. Default: 10. */
  minFrontGap?: number;
  /** Center-to-center clearance in meters needed behind in the new lane, plus 1.5 s of closing speed. Default: 10. */
  minRearGap?: number;
  /** Seconds to wait after a lane change finishes or is abandoned before choosing again. Default: 3. */
  cooldown?: number;
  /** Number of lanes on the road. Default: 3. */
  laneCount?: number;
}

/** Stateful lane chooser returned by createLaneChooser. */
interface LaneChooser {
  /**
   * Call once per tick. Returns the lane to steer toward relative to ego:
   * -1 left, 0 the current lane, 1 right.
   */
  update(input: AutopilotInput): number;
  /** Forgets any lane change in progress and the cooldown. */
  reset(): void;
}

/**
 * Creates a chooser that moves to whichever adjacent lane's traffic is fastest.
 *
 * A lane's speed is the speed of the closest vehicle ahead in it, within the
 * lookahead, or openLaneSpeed when nobody is there. An adjacent lane is chosen
 * only when it is at least minSpeedGain faster than the current lane and has
 * room to merge.
 *
 * Once a change starts, the chooser keeps returning that lane until ego crosses
 * into it, then returns 0 so you settle in the new lane's center. If the new
 * lane stops having room partway, it returns 0 to send ego back. After either,
 * it waits for the cooldown before choosing again.
 *
 * The chooser only picks a lane: your steering has to follow it, for example
 * analyzeLaneRegression(input.laneLines, relativeLane). Keep the returned object
 * outside autopilot(input) so its state survives between ticks.
 *
 * @param options Tuning. Every field is optional:
 * @param options.minSpeedGain Minimum speed gain, in m/s, an adjacent lane must offer before switching. Default 2.
 * @param options.lookahead Meters ahead to look for the vehicle that sets each lane's speed. Default 60.
 * @param options.openLaneSpeed Speed, in m/s, assumed for a lane with nobody ahead within the lookahead. Set it to your cruise speed. Default 29.
 * @param options.minFrontGap Center-to-center clearance, in meters, needed ahead in the new lane. Default 10.
 * @param options.minRearGap Center-to-center clearance, in meters, needed behind in the new lane, plus 1.5 s of the rear vehicle's closing speed. Default 10.
 * @param options.cooldown Seconds to wait after a lane change finishes or is abandoned before choosing again. Default 3.
 * @param options.laneCount Number of lanes on the road. Default 3.
 * @returns A chooser whose update(input) returns the lane to steer toward relative to ego (-1 left, 0 current, 1 right), and whose reset() clears its state.
 */
function createLaneChooser(options: LaneChooserOptions = {}): LaneChooser {
  const minSpeedGain = options.minSpeedGain ?? 2;
  const lookahead = options.lookahead ?? 60;
  const openLaneSpeed = options.openLaneSpeed ?? 29;
  const minFrontGap = options.minFrontGap ?? 10;
  const minRearGap = options.minRearGap ?? 10;
  const cooldown = options.cooldown ?? 3;
  const laneCount = options.laneCount ?? 3;
  // Absolute lane index being moved into, or undefined when holding the current lane.
  let targetLane: number | undefined;
  let cooldownRemaining = 0;

  return {
    update(input: AutopilotInput): number {
      const currentLane = input.ego.laneIndex;
      cooldownRemaining = Math.max(0, cooldownRemaining - input.dt);

      if (targetLane !== undefined) {
        const relativeTarget = targetLane - currentLane;
        if (relativeTarget === 0 || Math.abs(relativeTarget) > 1) {
          // Arrived, or ego ended up somewhere else entirely: either way the change is over.
          targetLane = undefined;
          cooldownRemaining = cooldown;
        } else if (hasRoomToMerge(input, relativeTarget, minFrontGap, minRearGap)) {
          return relativeTarget;
        } else {
          // The new lane filled up: head back and wait before trying again.
          targetLane = undefined;
          cooldownRemaining = cooldown;
          return 0;
        }
      }
      if (cooldownRemaining > 0) return 0;

      const currentSpeed = laneTrafficSpeed(input, 0, lookahead, openLaneSpeed);
      let bestRelativeLane = 0;
      let bestSpeed = currentSpeed;
      // Left is checked first, so it wins ties, matching the usual passing side.
      for (const relativeLane of [-1, 1]) {
        const lane = currentLane + relativeLane;
        if (lane < 0 || lane >= laneCount) continue;
        const speed = laneTrafficSpeed(input, relativeLane, lookahead, openLaneSpeed);
        if (speed - currentSpeed < minSpeedGain || speed <= bestSpeed) continue;
        if (!hasRoomToMerge(input, relativeLane, minFrontGap, minRearGap)) continue;
        bestRelativeLane = relativeLane;
        bestSpeed = speed;
      }
      if (bestRelativeLane !== 0) targetLane = currentLane + bestRelativeLane;
      return bestRelativeLane;
    },

    reset(): void {
      targetLane = undefined;
      cooldownRemaining = 0;
    },
  };
}

/**
 * Speed of the closest vehicle ahead in a lane, or openLaneSpeed when the lane
 * is empty within the lookahead.
 */
function laneTrafficSpeed(
  input: AutopilotInput,
  relativeLane: number,
  lookahead: number,
  openLaneSpeed: number
): number {
  const lead = closestVehicleAhead(input.vehicles, input.laneLines, relativeLane);
  if (!lead || lead.relativeY > lookahead) return openLaneSpeed;
  return input.ego.speed + lead.relativeVy;
}

/**
 * Checks that no vehicle in the lane is too close ahead, or too close behind
 * given how fast it is closing on ego.
 */
function hasRoomToMerge(
  input: AutopilotInput,
  relativeLane: number,
  minFrontGap: number,
  minRearGap: number
): boolean {
  return filterVehiclesInLane(input.vehicles, input.laneLines, relativeLane).every(vehicle => {
    if (vehicle.relativeY >= 0) return vehicle.relativeY >= minFrontGap;
    const closingSpeed = Math.max(0, vehicle.relativeVy);
    return -vehicle.relativeY >= minRearGap + closingSpeed * 1.5;
  });
}`;

export const toolboxLibrarySource = [
  clampImplementation,
  vehicleFilteringImplementation,
  pidControllerImplementation,
  laneInterpretationImplementation,
  accelerationFeedforwardImplementation,
  curveRegressionImplementation,
  adaptiveCruiseImplementation,
  laneSelectionImplementation,
  vehicleTrackerImplementation,
].join('\n\n');
