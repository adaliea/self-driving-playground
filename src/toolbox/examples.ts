import type { PlaygroundSettings } from '../types';

export interface ControllerExample {
  id: string;
  title: string;
  description: string;
  code: string;
  recommendedSettings?: Partial<PlaygroundSettings>;
}

export const controllerExamples: ControllerExample[] = [
  {
    id: 'pid-lane-default',
    title: 'PID lane keeping',
    description: 'Default working controller. Shows how P, I, and D terms shape lane-centering behavior.',
    code: `const lanePid = createPidController({
  // P reacts to the current offset from lane center.
  kp: 0.36,
  // I slowly removes persistent bias. Keep it small; too much I can wind up and cause slow weaving.
  ki: 0.004,
  // D damps fast changes so the car does not over-correct.
  kd: 0.12,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

const speedPid = createPidController({
  kp: 0.09,
  ki: 0.004,
  kd: 0.012,
  outputMin: -1,
  outputMax: 1,
  integralMin: -4,
  integralMax: 4,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const laneError = lane.centerOffset + lane.heading * 2.2;
  const steering = lanePid.update(laneError, input.dt);
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 28);
  const motor = accelerationFeedforward(targetSpeed, input.ego.speed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
    targetLane: input.targetLane,
  };
}`,
  },
  {
    id: 'p-only-lane',
    title: 'P-only lane keeping',
    description: 'Simple proportional steering. Good for showing steady-state error and oscillation.',
    code: `export function autopilot(input: AutopilotInput): AutopilotOutput {
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
    code: `const lanePid = createPidController({
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
  };
}`,
  },
  {
    id: 'adaptive-cruise',
    title: 'Adaptive cruise',
    description: 'Keeps the lane while reducing target speed when a lead vehicle is too close.',
    code: `const lanePid = createPidController({
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
    code: `const lanePid = createPidController({
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
    code: `const speedPid = createPidController({
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
  };
}`,
  },
  {
    id: 'bad-oscillator',
    title: 'Bad oscillating controller',
    description: 'Intentionally unstable. Useful for showing too much gain and delayed correction.',
    code: `let phase = 0;

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
