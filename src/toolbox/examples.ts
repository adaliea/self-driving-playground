import type { PlaygroundSettings } from '../types';

export interface ControllerExample {
  id: string;
  title: string;
  description: string;
  code: string;
  recommendedSettings?: Partial<PlaygroundSettings>;
}

/** Where the talk starts: bang-bang motor control, with "Steer for me" doing the steering. */
export const starterExample: ControllerExample = {
  id: 'starter',
  title: 'Starter: bang-bang',
  description: 'A deliberately crude starting point: half throttle, or coast when too close to the car ahead. "Steer for me" steers.',
  recommendedSettings: { steerAssist: true },
  code: `// Your car runs this function about 45 times a second. It reads the sensors
// in \`input\` and returns two commands, each from -1 to 1:
//   motor:    1 = full throttle, 0 = coast, -1 = full brake
//   steering: -1 = full left, 1 = full right
//
// "Steer for me" is on in Settings, so your steering is ignored for now.

// Coast when the car ahead is closer than this. Distances are measured
// center to center, and cars are about 4.6 m long.
const FOLLOW_DISTANCE = 30; // meters

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // The closest car ahead in your lane, or undefined if the lane is clear.
  const lead = closestVehicleAhead(input.vehicles, input.laneLines);
  // How far ahead it is, counting anything past 100 m (or nothing at all) as 100 m.
  const closestVehicleDistance = lead ? Math.min(lead.relativeY, 100) : 100;
  graph('distance to closest vehicle', closestVehicleDistance, 'm');

  // Bang-bang control: one of two fixed commands, nothing in between.
  let motor = 0.5;
  if (closestVehicleDistance < FOLLOW_DISTANCE) {
    motor = 0;
  }

  // How far the lane center is from you, in meters (positive is to your right).
  const lane = analyzeLane(input.laneLines);
  const steering = lane.centerOffset * 0.3;

  return { motor, steering };
}`,
};

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
  kd: 0.2,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});

const speedPid = createPidController({
  kp: 0.09,
  ki: 0.012,
  kd: 0.012,
  outputMin: -1,
  outputMax: 1,
  integralMin: -14,
  integralMax: 14,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  // Heading says where the offset is heading next; weighting it looks ahead about 8 m.
  const laneError = lane.centerOffset + lane.heading * 8;
  const steering = lanePid.update(laneError, input.dt);
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 28);
  const motor = speedFeedforward(targetSpeed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
  };
}`,
  },
  starterExample,
  {
    id: 'p-only-lane',
    title: 'P-only lane keeping',
    description: 'Simple proportional steering. Good for showing steady-state error and oscillation.',
    code: `export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lane.centerOffset * 0.36 + lane.heading * 3;

  return {
    motor: 0.34,
    steering: clamp(steering, -1, 1),
  };
}`,
  },
  {
    id: 'pid-lane-speed',
    title: 'PID lane plus speed',
    description: 'Lane PID and speed PID, each with a feedforward term.',
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
  integralMin: -14,
  integralMax: 14,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lanePid.update(lane.centerOffset + lane.heading * 4, input.dt) +
    steeringFeedforward(lane.curvature, input.ego.speed);
  const targetSpeed = 28;
  const speedError = targetSpeed - input.ego.speed;
  const motor = speedFeedforward(targetSpeed) + speedPid.update(speedError, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
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
  integralMin: -16,
  integralMax: 16,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const lane = analyzeLane(input.laneLines);
  const steering = lanePid.update(lane.centerOffset + lane.heading * 4, input.dt) +
    steeringFeedforward(lane.curvature, input.ego.speed);
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 30);
  const motor = speedFeedforward(targetSpeed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
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
  const steering = lanePid.update(lane.centerOffset + lane.heading * 4, input.dt) +
    steeringFeedforward(lane.curvature, input.ego.speed);

  return {
    // This motor value is intentionally ignored when "Accelerate for me" is on.
    motor: 0,
    steering: clamp(steering, -1, 1),
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
  integralMin: -14,
  integralMax: 14,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 29);
  const motor = speedFeedforward(targetSpeed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    // This steering value is intentionally ignored when "Steer for me" is on.
    steering: 0,
  };
}`,
  },
  {
    id: 'fastest-lane',
    title: 'Fastest lane',
    description: 'Lane keeping and adaptive cruise that move to an adjacent lane when its traffic is faster by a configurable margin.',
    code: `// Minimum speed advantage, in m/s, before changing lanes. Raise it to change lanes less often.
const laneChooser = createLaneChooser({ minSpeedGain: 2.5 });

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
  kp: 0.09,
  ki: 0.012,
  kd: 0.012,
  outputMin: -1,
  outputMax: 1,
  integralMin: -14,
  integralMax: 14,
});

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // -1 / 1 while moving into the left / right lane, otherwise 0.
  const relativeLane = laneChooser.update(input);

  // Steer toward the chosen lane's center. Limiting the error keeps the lane change gentle.
  const lane = analyzeLane(input.laneLines, relativeLane);
  const laneError = clamp(lane.centerOffset, -1.2, 1.2) + lane.heading * 4;
  const steering = lanePid.update(laneError, input.dt) +
    steeringFeedforward(lane.curvature, input.ego.speed);

  // Watch the lane being entered as well as the current one.
  const targetSpeed = adaptiveCruiseTargetSpeed(input, 29, relativeLane);
  const motor = speedFeedforward(targetSpeed) +
    speedPid.update(targetSpeed - input.ego.speed, input.dt);

  return {
    motor: clamp(motor, -1, 1),
    steering: clamp(steering, -1, 1),
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
  };
}`,
  },
];

export const defaultControllerExample = controllerExamples[0];
