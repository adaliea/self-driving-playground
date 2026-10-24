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
  vehicles: VehicleTrack[],
  laneLines: LaneLineDetections,
  relativeLane = 0
): VehicleTrack[] {
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
  vehicles: VehicleTrack[],
  laneLines: LaneLineDetections,
  relativeLane = 0
): VehicleTrack | undefined {
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

export const speedFeedforwardImplementation = `/**
 * Estimates the motor command that holds a speed steady.
 *
 * At a constant speed the motor only has to cancel drag, and the motor gets
 * weaker as the car nears its top speed. This models both exactly, but not
 * the wind: each run has a steady headwind or tailwind plus gusts. Add PID
 * feedback on the speed error. P closes the gap to a new speed and I learns
 * the steady wind this estimate can't see.
 *
 * @param targetSpeed Speed to hold, in meters per second.
 * @returns Normalized motor estimate in [0, 1].
 */
function speedFeedforward(targetSpeed: number): number {
  const speed = Math.max(0, targetSpeed);
  // Air drag grows with speed squared, rolling resistance with speed.
  const dragAccel = 0.00085 * speed * speed + 0.012 * speed;
  // Full motor pushes 4.5 m/s² at standstill, fading to nothing at the 58 m/s top speed.
  const fullMotorAccel = 4.5 * (1 - Math.pow(Math.min(speed / 58, 1), 1.65));
  return clamp(dragAccel / Math.max(fullMotorAccel, 0.01), 0, 1);
}`;

export const steeringFeedforwardImplementation = `/**
 * Estimates the steering command that follows a curve.
 *
 * Steering sets how fast the car turns: full lock turns at 0.68 rad/s, less
 * below 22 m/s. Following a curve means turning at curvature × speed, so this
 * inverts that. Add PID feedback on the lane error to correct whatever drift
 * the estimate leaves behind.
 *
 * @param curvature Lane curvature in 1/m, from analyzeLane(...).curvature. Positive curves right.
 * @param speed Ego speed in meters per second.
 * @returns Normalized steering estimate in [-1, 1].
 */
function steeringFeedforward(curvature: number, speed: number): number {
  const fullLockTurnRate = 0.68 * clamp(speed / 22, 0.08, 1);
  return clamp((curvature * speed) / fullLockTurnRate, -1, 1);
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
    .filter((vehicle): vehicle is VehicleTrack => vehicle !== undefined)
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
 * analyzeLane(input.laneLines, relativeLane). Keep the returned object
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
  speedFeedforwardImplementation,
  steeringFeedforwardImplementation,
  adaptiveCruiseImplementation,
  laneSelectionImplementation,
].join('\n\n');
