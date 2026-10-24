export interface ToolboxSnippet {
  id: string;
  title: string;
  category: string;
  description: string;
  /**
   * Declarations that must live outside autopilot(input) so they keep their state
   * between ticks. Each is added above autopilot unless its name is already declared.
   */
  setup?: string[];
  /** Lines to insert at the cursor, usually inside autopilot(input). */
  usage: string;
  /** Builds setup and usage from the code being edited, for snippets that adapt to it. */
  build?: (source: string) => SnippetInsertion;
}

export interface SnippetInsertion {
  setup?: string[];
  usage: string;
}

/** What inserting a snippet adds to `source`. */
export function snippetInsertion(snippet: ToolboxSnippet, source: string): SnippetInsertion {
  return snippet.build ? snippet.build(source) : { setup: snippet.setup, usage: snippet.usage };
}

function isDeclared(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(source);
}

const PID_NAME_WORDS = ['rocket', 'turbo', 'comet', 'pickle', 'waffle', 'otter', 'mango', 'pixel', 'zippy', 'noodle', 'falcon', 'banjo'];

/**
 * Names a new PID: distancePid first (following the car ahead), then lanePid,
 * then a random word so each controller gets its own telemetry card.
 */
function newPidName(source: string): string {
  for (const name of ['distancePid', 'lanePid']) if (!isDeclared(source, name)) return name;
  const free = PID_NAME_WORDS.map((word) => `${word}Pid`).filter((name) => !isDeclared(source, name));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  for (let index = 2; ; index += 1) if (!isDeclared(source, `pid${index}`)) return `pid${index}`;
}

function buildPidInsertion(source: string): SnippetInsertion {
  const name = newPidName(source);
  if (name === 'distancePid') {
    // Reuse the starter's closestVehicleDistance when the code already has one.
    const findDistance = isDeclared(source, 'closestVehicleDistance')
      ? ''
      : `const closestVehicle = closestVehicleAhead(input.vehicles, input.laneLines);
// Anything past 100 m, or nothing at all, counts as 100 m.
const closestVehicleDistance = closestVehicle ? Math.min(closestVehicle.relativeY, 100) : 100;
`;
    return {
      // Deliberately under-damped (kd 0.15 is calmer) so there is something to tune.
      setup: [`const distancePid = createPidController({
  kp: 0.05,
  ki: 0,
  kd: 0.08,
  outputMin: -1,
  // Also a speed limit: 0.4 motor balances drag at about 30 m/s.
  outputMax: 0.4,
});`],
      usage: `${findDistance}// Error = distance to the car ahead − the distance you want, in m. Positive means too far back.
const distancePidOutput = distancePid.update(closestVehicleDistance - 30, input.dt);`,
    };
  }
  if (name === 'lanePid') {
    return {
      // Starts a little loose, so there is something to tune.
      setup: [`const lanePid = createPidController({
  kp: 0.3,
  ki: 0,
  kd: 0.11,
  outputMin: -1,
  outputMax: 1,
});`],
      usage: `// Error = distance to the lane center, in m. Positive means the center is to your right.
const lanePidOutput = lanePid.update(analyzeLane(input.laneLines).centerOffset, input.dt);`,
    };
  }
  return {
    setup: [`const ${name} = createPidController({
  kp: 0.1,
  ki: 0,
  kd: 0,
  outputMin: -1,
  outputMax: 1,
});`],
    usage: `// Replace 0 with the error this PID should drive to zero.
const ${name}Output = ${name}.update(0, input.dt);`,
  };
}

const lanePidSetup = `const lanePid = createPidController({
  kp: 0.36,
  ki: 0.015,
  kd: 0.11,
  outputMin: -1,
  outputMax: 1,
  integralMin: -2,
  integralMax: 2,
});`;

const speedPidSetup = `const speedPid = createPidController({
  kp: 0.09,
  ki: 0.012,
  kd: 0.012,
  outputMin: -1,
  outputMax: 1,
  integralMin: -14,
  integralMax: 14,
});`;

export const toolboxSnippets: ToolboxSnippet[] = [
  {
    id: 'clamp',
    title: 'Clamp Helper',
    category: 'Safety',
    description: 'Keeps motor and steering commands inside the valid [-1, 1] range.',
    usage: `const safeSteering = clamp(steering, -1, 1);
const safeMotor = clamp(motor, -1, 1);`,
  },
  {
    id: 'vehicle-filtering',
    title: 'Vehicle Filtering',
    category: 'Perception',
    description: 'Find vehicles whose bounding box overlaps a lane and pick the closest one ahead for following-distance control.',
    usage: `const leadVehicle = closestVehicleAhead(input.vehicles, input.laneLines);
const gapMeters = leadVehicle?.relativeY ?? Number.POSITIVE_INFINITY;`,
  },
  {
    id: 'pid-controller',
    title: 'PID Controller Object',
    category: 'Control',
    description: 'A stateful PID controller with integral limiting, output limiting, reset, and automatic PID telemetry.',
    usage: '',
    build: buildPidInsertion,
  },
  {
    id: 'analyze-lane',
    title: 'Lane Reading',
    category: 'Perception',
    description: 'Fits a smooth curve through the noisy lane-line samples and reports how far you are from the lane center, your angle to it, and how the road bends.',
    usage: `const lane = analyzeLane(input.laneLines);
const laneError = lane.centerOffset + lane.heading * 4;`,
  },
  {
    id: 'speed-feedforward',
    title: 'Speed Feedforward',
    category: 'Control',
    description: 'Estimates the motor needed to hold a target speed against drag, so the PID only has to correct what the estimate gets wrong.',
    setup: [speedPidSetup],
    usage: `const targetSpeed = 28;
const motor = speedFeedforward(targetSpeed) +
  speedPid.update(targetSpeed - input.ego.speed, input.dt);`,
  },
  {
    id: 'steering-feedforward',
    title: 'Steering Feedforward',
    category: 'Control',
    description: 'Estimates the steering needed to follow the curve ahead, so the lane PID only has to correct the drift.',
    setup: [lanePidSetup],
    usage: `const lane = analyzeLane(input.laneLines);
const laneError = lane.centerOffset + lane.heading * 4;
const steering = steeringFeedforward(lane.curvature, input.ego.speed) +
  lanePid.update(laneError, input.dt);`,
  },
  {
    id: 'lateral-velocity',
    title: 'Lateral Velocity Steering',
    category: 'Control',
    description: 'Steers so the car slides sideways at the speed you ask for. You decide that speed, for example with a PID on how far you are from the lane center.',
    usage: `// How fast to slide sideways, in m/s (positive is right). Try a PID on lane.centerOffset.
const targetLateralVelocity = 0;
const steering = lateralVelocitySteering(input, targetLateralVelocity);`,
  },
  {
    id: 'adaptive-cruise',
    title: 'Adaptive Cruise Snippet',
    category: 'Following',
    description: 'Reduces target speed when the closest vehicle ahead is inside the desired following gap.',
    setup: [speedPidSetup],
    usage: `const targetSpeed = adaptiveCruiseTargetSpeed(input, 29);
const motor = speedFeedforward(targetSpeed) +
  speedPid.update(targetSpeed - input.ego.speed, input.dt);`,
  },
  {
    id: 'fastest-lane',
    title: 'Fastest Lane Selection',
    category: 'Planning',
    description: 'Picks an adjacent lane whose traffic is faster by at least a minimum speed differential, and holds it until the lane change finishes.',
    setup: [`// Only switch when the other lane is at least 3 m/s faster.
const laneChooser = createLaneChooser({ minSpeedGain: 3 });`],
    usage: `const relativeLane = laneChooser.update(input);
const lane = analyzeLane(input.laneLines, relativeLane);
const targetSpeed = adaptiveCruiseTargetSpeed(input, 29, relativeLane);
// ...steer on lane.centerOffset and lane.heading as usual.`,
  },
];
