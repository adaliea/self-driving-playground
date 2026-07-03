export interface ToolboxSnippet {
  id: string;
  title: string;
  category: string;
  description: string;
  implementation: string;
  usage: string;
}

export const toolboxSnippets: ToolboxSnippet[] = [
  {
    id: 'clamp',
    title: 'Clamp Helper',
    category: 'Safety',
    description: 'Keeps motor and steering commands inside the valid [-1, 1] range.',
    implementation: `function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}`,
    usage: `const safeSteering = clamp(steering, -1, 1);
const safeMotor = clamp(motor, -1, 1);`,
  },
  {
    id: 'vehicle-filtering',
    title: 'Vehicle Filtering',
    category: 'Perception',
    description: 'Find vehicles in a lane and pick the closest one ahead for following-distance control.',
    implementation: `function filterVehiclesInLane(
  vehicles: VehicleDetection[],
  laneIndex: number
): VehicleDetection[] {
  return vehicles.filter(vehicle => vehicle.laneIndex === laneIndex);
}

function closestVehicleAhead(
  vehicles: VehicleDetection[],
  laneIndex: number
): VehicleDetection | undefined {
  return filterVehiclesInLane(vehicles, laneIndex)
    .filter(vehicle => vehicle.relativeY > 0)
    .sort((a, b) => a.relativeY - b.relativeY)[0];
}`,
    usage: `const leadVehicle = closestVehicleAhead(input.vehicles, input.ego.laneIndex);
const gapMeters = leadVehicle?.relativeY ?? Number.POSITIVE_INFINITY;`,
  },
  {
    id: 'pid-controller',
    title: 'PID Controller Object',
    category: 'Control',
    description: 'A stateful PID controller with integral limiting, output limiting, reset, and optional debug terms.',
    implementation: `interface PidGains {
  kp: number;
  ki: number;
  kd: number;
}

interface PidControllerOptions extends PidGains {
  outputMin?: number;
  outputMax?: number;
  integralMin?: number;
  integralMax?: number;
}

function createPidController(options: PidControllerOptions) {
  let integral = 0;
  let previousError = 0;
  let hasPreviousError = false;
  let lastTerms = {
    error: 0,
    proportional: 0,
    integral: 0,
    derivative: 0,
    output: 0,
  };

  return {
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

    getDebug() {
      return lastTerms;
    },

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
}`,
    usage: `const lanePid = createPidController({
  kp: 0.36,
  ki: 0.015,
  kd: 0.11,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

const steering = lanePid.update(laneError, input.dt);`,
  },
  {
    id: 'analyze-lane',
    title: 'Lane Interpretation',
    category: 'Perception',
    description: 'Turns raw lane-line samples into center offset, heading, curvature, and confidence.',
    implementation: `interface LaneAnalysis {
  centerOffset: number;
  heading: number;
  curvature: number;
  confidence: number;
}

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
}`,
    usage: `const lane = analyzeLane(input.laneLines);
const laneError = lane.centerOffset + lane.heading * 2.5;`,
  },
  {
    id: 'feedforward',
    title: 'Acceleration Feedforward',
    category: 'Control',
    description: 'Adds a rough motor estimate for nonlinear acceleration and drag before PID feedback.',
    implementation: `function accelerationFeedforward(
  targetSpeed: number,
  currentSpeed: number
): number {
  const speedError = targetSpeed - currentSpeed;
  const dragCompensation = 0.00048 * currentSpeed * currentSpeed + 0.004 * currentSpeed;
  const requestedAccel = speedError * 0.09 + dragCompensation;
  return clamp(requestedAccel, -1, 1);
}`,
    usage: `const targetSpeed = 28;
const motor = accelerationFeedforward(targetSpeed, input.ego.speed);`,
  },
  {
    id: 'curve-regression',
    title: 'Curve Regression Helper',
    category: 'Perception',
    description:
      'Uses the built-in weighted lane regression helper to estimate center offset, heading, and curvature on sharper turns.',
    implementation: `function analyzeTargetLane(input: AutopilotInput): LaneAnalysis {
  const relativeTargetLane = input.targetLane - input.ego.laneIndex;
  return analyzeLaneRegression(input.laneLines, relativeTargetLane);
}

function curvatureSteeringFeedforward(
  lane: LaneAnalysis,
  speed: number
): number {
  const steeringScale = Math.max(0.08, Math.min(1, speed / 22));
  const feedforward = (lane.curvature * speed) / Math.max(0.08, 0.68 * steeringScale);
  return clamp(feedforward, -0.4, 0.4);
}`,
    usage: `const lane = analyzeTargetLane(input);
const laneError = lane.centerOffset + lane.heading * 2.0;
const feedback = lanePid.update(laneError, input.dt);
const feedforward = curvatureSteeringFeedforward(lane, input.ego.speed);
const steering = clamp(feedback + feedforward, -1, 1);`,
  },
  {
    id: 'adaptive-cruise',
    title: 'Adaptive Cruise Snippet',
    category: 'Following',
    description: 'Reduces target speed when the closest vehicle ahead is inside the desired following gap.',
    implementation: `function adaptiveCruiseTargetSpeed(
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
}`,
    usage: `const targetSpeed = adaptiveCruiseTargetSpeed(input, 29);
const motor = speedPid.update(targetSpeed - input.ego.speed, input.dt);`,
  },
];
