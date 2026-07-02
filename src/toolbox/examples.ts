import type { PlaygroundSettings } from '../types';

export interface ControllerExample {
  id: string;
  title: string;
  description: string;
  code: string;
  recommendedSettings?: Partial<PlaygroundSettings>;
}

const clampHelper = `function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}`;

const laneAnalyzer = `interface LaneAnalysis {
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
}`;

const pidController = `interface PidGains {
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

      const proportional = options.kp * error;
      const integralTerm = options.ki * integral;
      const derivativeTerm = options.kd * derivative;
      const output = clamp(
        proportional + integralTerm + derivativeTerm,
        options.outputMin ?? Number.NEGATIVE_INFINITY,
        options.outputMax ?? Number.POSITIVE_INFINITY
      );

      lastTerms = {
        error,
        proportional,
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
    },
  };
}`;

const speedHelpers = `function accelerationFeedforward(targetSpeed: number, currentSpeed: number): number {
  const speedError = targetSpeed - currentSpeed;
  const dragCompensation = 0.00048 * currentSpeed * currentSpeed + 0.004 * currentSpeed;
  return clamp(speedError * 0.09 + dragCompensation, -1, 1);
}

function filterVehiclesInLane(
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
}

function adaptiveCruiseTargetSpeed(input: AutopilotInput, freeRoadSpeed: number): number {
  const lead = closestVehicleAhead(input.vehicles, input.ego.laneIndex);
  if (!lead) return freeRoadSpeed;

  const leadSpeed = input.ego.speed + lead.relativeVy;
  const targetGap = 10 + input.ego.speed * 1.25;
  const gapError = lead.relativeY - targetGap;

  if (gapError > 18) return freeRoadSpeed;
  return Math.max(4, Math.min(freeRoadSpeed, leadSpeed + gapError * 0.35));
}`;

export const controllerExamples: ControllerExample[] = [
  {
    id: 'pid-lane-default',
    title: 'PID lane keeping',
    description: 'Default working controller. Shows how P, I, and D terms shape lane-centering behavior.',
    code: `${clampHelper}

${laneAnalyzer}

${pidController}

const lanePid = createPidController({
  // P reacts to the current offset from lane center.
  kp: 0.36,
  // I slowly removes persistent bias from noisy sensors or curved roads.
  ki: 0.014,
  // D damps fast changes so the car does not over-correct.
  kd: 0.12,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const laneError = lane.centerOffset + lane.heading * 2.2;
  const steering = lanePid.update(laneError, input.dt);

  return {
    motor: 0.36,
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
    debug: {
      lanePid: lanePid.getDebug(),
    },
  };
}`,
  },
  {
    id: 'p-only-lane',
    title: 'P-only lane keeping',
    description: 'Simple proportional steering. Good for showing steady-state error and oscillation.',
    code: `${clampHelper}

${laneAnalyzer}

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lane.centerOffset * 0.28 + lane.heading * 0.85;

  return {
    motor: 0.34,
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
  };
}`,
  },
  {
    id: 'pid-lane-speed',
    title: 'PID lane plus speed',
    description: 'Lane PID plus a speed PID and feedforward term.',
    code: `${clampHelper}

${laneAnalyzer}

${pidController}

${speedHelpers}

const lanePid = createPidController({
  kp: 0.36,
  ki: 0.014,
  kd: 0.12,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

const speedPid = createPidController({
  kp: 0.08,
  ki: 0.012,
  kd: 0.01,
  outputMin: -1,
  outputMax: 1,
  integralMin: -4,
  integralMax: 4,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lanePid.update(lane.centerOffset + lane.heading * 2.2, input.dt);
  const targetSpeed = 28;
  const speedError = targetSpeed - input.ego.speed;
  const motor = accelerationFeedforward(targetSpeed, input.ego.speed) + speedPid.update(speedError, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
    debug: {
      lanePid: lanePid.getDebug(),
      speedPid: speedPid.getDebug(),
    },
  };
}`,
  },
  {
    id: 'adaptive-cruise',
    title: 'Adaptive cruise',
    description: 'Keeps the lane while reducing target speed when a lead vehicle is too close.',
    code: `${clampHelper}

${laneAnalyzer}

${pidController}

${speedHelpers}

const lanePid = createPidController({
  kp: 0.36,
  ki: 0.012,
  kd: 0.11,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

const speedPid = createPidController({
  kp: 0.09,
  ki: 0.01,
  kd: 0.018,
  outputMin: -1,
  outputMax: 1,
  integralMin: -4,
  integralMax: 4,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lanePid.update(lane.centerOffset + lane.heading * 2.1, input.dt);
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 30);
  const motor = accelerationFeedforward(targetSpeed, input.ego.speed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
    debug: {
      lanePid: lanePid.getDebug(),
      speedPid: speedPid.getDebug(),
    },
  };
}`,
  },
  {
    id: 'lane-with-accel-assist',
    title: 'Lane keeping with accel assist',
    description: 'Focus only on steering PID while the simulator overrides motor control.',
    recommendedSettings: {
      accelerateAssist: true,
      steerAssist: false,
    },
    code: `${clampHelper}

${laneAnalyzer}

${pidController}

const lanePid = createPidController({
  kp: 0.35,
  ki: 0.012,
  kd: 0.12,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lanePid.update(lane.centerOffset + lane.heading * 2.2, input.dt);

  return {
    // This motor value is intentionally ignored when "Accelerate for me" is on.
    motor: 0,
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
    debug: {
      lanePid: lanePid.getDebug(),
    },
  };
}`,
  },
  {
    id: 'speed-with-steer-assist',
    title: 'Speed control with steer assist',
    description: 'Focus on motor output and following distance while the simulator handles steering.',
    recommendedSettings: {
      steerAssist: true,
      accelerateAssist: false,
    },
    code: `${clampHelper}

${pidController}

${speedHelpers}

const speedPid = createPidController({
  kp: 0.09,
  ki: 0.012,
  kd: 0.012,
  outputMin: -1,
  outputMax: 1,
  integralMin: -4,
  integralMax: 4,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 29);
  const motor = accelerationFeedforward(targetSpeed, input.ego.speed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    // This steering value is intentionally ignored when "Steer for me" is on.
    steering: 0,
    targetLane: input.targetLane,
    debug: {
      speedPid: speedPid.getDebug(),
    },
  };
}`,
  },
  {
    id: 'bad-oscillator',
    title: 'Bad oscillating controller',
    description: 'Intentionally unstable. Useful for showing too much gain and delayed correction.',
    code: `${clampHelper}

${laneAnalyzer}

let phase = 0;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  phase += input.dt * 7.5;
  const lane = analyzeLane(input.laneLines);
  const steering = lane.centerOffset * 0.72 + Math.sin(phase) * 0.72;

  return {
    motor: 0.62,
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
  };
}`,
  },
];

export const defaultControllerExample = controllerExamples[0];
