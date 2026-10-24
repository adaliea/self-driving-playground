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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

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

  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  // How far that lane's center is from you, in meters (positive is to your right).
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
  const steering = lane.centerOffset * 0.3;

  return { motor, steering };
}`,
};

/** The starter after the talk's first fix: brake hard when far too close. */
export const brakingStarterExample: ControllerExample = {
  ...starterExample,
  id: 'starter-braking',
  title: 'Starter: bang-bang with braking',
  description: 'The starter plus a hard brake when the car ahead is far too close.',
  code: starterExample.code
    .replace(
      'const FOLLOW_DISTANCE = 30; // meters\n',
      'const FOLLOW_DISTANCE = 30; // meters\n// Brake hard when the car ahead is closer than this.\nconst TOO_CLOSE_DISTANCE = 15; // meters\n',
    )
    .replace(
      '    motor = 0;\n  }\n',
      '    motor = 0;\n  }\n  if (closestVehicleDistance < TOO_CLOSE_DISTANCE) {\n    motor = -1;\n  }\n',
    ),
};

/**
 * "Catch up to presenter" checkpoint for the PID step: the braking starter, with
 * a TODO where the bang-bang rule should become a PID loop.
 */
export const pidCheckpointExample: ControllerExample = {
  id: 'checkpoint-pid',
  title: 'Checkpoint: ready for a PID loop',
  description: 'Hard braking added, with steps for replacing the bang-bang rule with a PID loop.',
  code: brakingStarterExample.code.replace(
    '  // Bang-bang control: one of two fixed commands, nothing in between.\n',
    `  // Bang-bang control: one of two fixed commands, nothing in between.
  // TODO: Replace this with a PID loop on the distance to the closest vehicle:
  //   1. Delete \`let motor = 0.5;\` and both if-blocks below.
  //   2. Type \`let motor = \`, then Toolbox → PID Controller Object → Insert usage.
`,
  ),
};

/**
 * "What I came up with": a tuned distance PID with spacing that grows with speed.
 * Also a catch-up checkpoint, and where the steering feedforward demo starts.
 */
export const tunedFollowingExample: ControllerExample = {
  id: 'checkpoint-tuned-following',
  title: 'Checkpoint: what I came up with',
  description: 'A tuned distance PID that follows close in slow traffic and leaves more room at speed.',
  code: `// Your car runs this function about 45 times a second. It reads the sensors
// in \`input\` and returns two commands, each from -1 to 1:
//   motor:    1 = full throttle, 0 = coast, -1 = full brake
//   steering: -1 = full left, 1 = full right

// Follow close in slow traffic and leave more room at speed: a car length or so,
// plus about one second of travel. Distances are center to center.
const MIN_DISTANCE = 7; // meters
const FOLLOW_TIME = 1.0; // seconds

const distancePid = createPidController({
  kp: 0.1,
  ki: 0.01,
  kd: 0.3,
  outputMin: -1,
  // Also a speed limit: 0.75 motor balances drag at about 38 m/s.
  outputMax: 0.75,
  // Stops I from building up while the lane ahead is clear.
  integralMin: -20,
  integralMax: 20,
});

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // The closest car ahead in your lane, or undefined if the lane is clear.
  const lead = closestVehicleAhead(input.vehicles, input.laneLines);
  // How far ahead it is, counting anything past 100 m (or nothing at all) as 100 m.
  const closestVehicleDistance = lead ? Math.min(lead.relativeY, 100) : 100;

  const targetDistance = MIN_DISTANCE + FOLLOW_TIME * input.ego.speed;
  graph('distance to closest vehicle', closestVehicleDistance, 'm');
  graph('target distance', targetDistance, 'm');

  // Error = distance to the car ahead − the distance you want. Positive means too far back.
  const motor = distancePid.update(closestVehicleDistance - targetDistance, input.dt);

  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  // How far that lane's center is from you, in meters (positive is to your right).
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
  const steering = lane.centerOffset * 0.3;

  return { motor, steering };
}`,
};

const P_STEERING = '  const steering = lane.centerOffset * 0.3;';

/** "Catch up to presenter" for the steering PID step: the tuned following code, with a TODO on steering. */
export const steeringPidCheckpointExample: ControllerExample = {
  id: 'checkpoint-steering-pid',
  title: 'Checkpoint: ready for a steering PID',
  description: 'Tuned following, with steps for replacing the fixed steering multiplier with a PID.',
  code: tunedFollowingExample.code.replace(
    P_STEERING,
    `  // TODO: Steer with a PID instead of a fixed multiplier:
  //   1. Select \`lane.centerOffset * 0.3\` below.
  //   2. Toolbox → PID Controller Object → Insert usage.
  //   3. Tune lanePid. Start with kd, then kp.
${P_STEERING}`,
  ),
};

const TUNED_LANE_PID = `// Error = distance to the lane center, in m. Positive means the center is to your right.
const lanePid = createPidController({
  kp: 0.5,
  ki: 0,
  kd: 0.1,
  outputMin: -1,
  outputMax: 1,
});

`;

/** "What I came up with" for steering: a tuned lane PID that still wobbles in curves. */
export const tunedSteeringExample: ControllerExample = {
  id: 'checkpoint-tuned-steering',
  title: 'Checkpoint: tuned steering PID',
  description: 'Tuned following and a tuned lane PID. Still drifts a little in curves.',
  code: tunedFollowingExample.code
    .replace('export function autopilot', `${TUNED_LANE_PID}export function autopilot`)
    .replace(P_STEERING, '  const steering = lanePid.update(lane.centerOffset, input.dt);'),
};

/** Ready to race: the tuned steering PID plus steering feedforward for the curves. */
export const raceReadyExample: ControllerExample = {
  id: 'checkpoint-race-ready',
  title: 'Checkpoint: ready to race',
  description: 'Tuned following and steering, with steering feedforward for the curves.',
  code: tunedSteeringExample.code.replace(
    '  const steering = lanePid.update(lane.centerOffset, input.dt);',
    `  // Feedforward turns with the road; the PID only corrects the drift.
  const steering = lanePid.update(lane.centerOffset, input.dt) +
    steeringFeedforward(lane.curvature, input.ego.speed);`,
  ),
};

/** Checkpoints the presenter can send everyone to, by id. */
export const checkpointExamples: ControllerExample[] = [
  pidCheckpointExample,
  tunedFollowingExample,
  steeringPidCheckpointExample,
  tunedSteeringExample,
  raceReadyExample,
];

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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
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
    code: `// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
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

// The lane the car starts in. Lanes are numbered 0, 1, 2 from the left.
let homeLane: number | undefined;

export function autopilot(input: AutopilotInput): AutopilotOutput {
  phase += input.dt * 7.5;
  // Remember the lane you start in, and keep steering for it even after drifting.
  if (homeLane === undefined) {
    homeLane = input.ego.laneIndex;
  }
  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);
  const steering = lane.centerOffset * 0.72 + Math.sin(phase) * 0.72;

  return {
    motor: 0.62,
    steering: clamp(steering, -1, 1),
  };
}`,
  },
];

export const defaultControllerExample = controllerExamples[0];
