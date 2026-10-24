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
  /** The call inserted at the cursor, e.g. after `const steering = `. */
  usage: string;
  /** Builds setup and usage from the code being edited, for snippets that adapt to it. */
  build?: (source: string, cursorLine: string) => SnippetInsertion;
}

export interface SnippetInsertion {
  setup?: string[];
  usage: string;
}

/** What inserting a snippet adds to `source`, given the line the cursor is on. */
export function snippetInsertion(snippet: ToolboxSnippet, source: string, cursorLine = ''): SnippetInsertion {
  return snippet.build ? snippet.build(source, cursorLine) : { setup: snippet.setup, usage: snippet.usage };
}

function isDeclared(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(source);
}

/** `lane.<field>` when the code already reads the lane, otherwise a fresh read. */
function laneField(source: string, field: string): string {
  return isDeclared(source, 'lane') ? `lane.${field}` : `analyzeLane(input.laneLines).${field}`;
}

const PID_NAME_WORDS = ['rocket', 'turbo', 'comet', 'pickle', 'waffle', 'otter', 'mango', 'pixel', 'zippy', 'noodle', 'falcon', 'banjo'];

/**
 * Names a new PID from the line it is inserted on: lanePid on a steering line, distancePid
 * on a motor line. Otherwise distancePid, then lanePid, then a random word, so each
 * controller gets its own telemetry card.
 */
function newPidName(source: string, cursorLine: string): string {
  const preferred = /steering|centerOffset/.test(cursorLine) ? 'lanePid' : /motor|Distance/.test(cursorLine) ? 'distancePid' : undefined;
  if (preferred && !isDeclared(source, preferred)) return preferred;
  for (const name of ['distancePid', 'lanePid']) if (!isDeclared(source, name)) return name;
  const free = PID_NAME_WORDS.map((word) => `${word}Pid`).filter((name) => !isDeclared(source, name));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  for (let index = 2; ; index += 1) if (!isDeclared(source, `pid${index}`)) return `pid${index}`;
}

function buildPidInsertion(source: string, cursorLine: string): SnippetInsertion {
  const name = newPidName(source, cursorLine);
  if (name === 'distancePid') {
    const target = isDeclared(source, 'targetDistance') ? 'targetDistance' : '30';
    return {
      // Deliberately under-damped (kd 0.15 is calmer) so there is something to tune.
      setup: [`// Error = distance to the car ahead − the distance you want. Positive means too far back.
const distancePid = createPidController({
  kp: 0.05,
  ki: 0,
  kd: 0.08,
  outputMin: -1,
  // Also a speed limit: 0.75 motor balances drag at about 38 m/s.
  outputMax: 0.75,
  // Stops I from building up while the lane ahead is clear.
  integralMin: -20,
  integralMax: 20,
});`],
      usage: `distancePid.update(closestVehicleDistance - ${target}, input.dt)`,
    };
  }
  if (name === 'lanePid') {
    return {
      // Behaves exactly like `lane.centerOffset * 0.3` until it is tuned.
      setup: [`// Error = distance to the lane center, in m. Positive means the center is to your right.
const lanePid = createPidController({
  kp: 0.3,
  ki: 0,
  kd: 0,
  outputMin: -1,
  outputMax: 1,
});`],
      usage: `lanePid.update(${laneField(source, 'centerOffset')}, input.dt)`,
    };
  }
  return {
    setup: [`// Replace 0 in ${name}.update(0, input.dt) with the error this PID should drive to zero.
const ${name} = createPidController({
  kp: 0.1,
  ki: 0,
  kd: 0,
  outputMin: -1,
  outputMax: 1,
});`],
    usage: `${name}.update(0, input.dt)`,
  };
}

export const toolboxSnippets: ToolboxSnippet[] = [
  {
    id: 'clamp',
    title: 'Clamp Helper',
    category: 'Safety',
    description: 'Keeps a number inside a range, like motor and steering inside [-1, 1].',
    usage: 'clamp(motor, -1, 1)',
  },
  {
    id: 'vehicle-filtering',
    title: 'Vehicle Filtering',
    category: 'Perception',
    description: 'Finds the closest car ahead whose bounding box overlaps your lane, or undefined if the lane is clear.',
    usage: 'closestVehicleAhead(input.vehicles, input.laneLines)',
  },
  {
    id: 'pid-controller',
    title: 'PID Controller Object',
    category: 'Control',
    description:
      'A PID controller with output limits, derivative smoothing, and automatic telemetry. Adds the controller above autopilot and its update call at your cursor.',
    usage: '',
    build: buildPidInsertion,
  },
  {
    id: 'analyze-lane',
    title: 'Lane Reading',
    category: 'Perception',
    description: 'Fits a smooth curve through the noisy lane-line samples and reports how far you are from the lane center, your angle to it, and how the road bends.',
    usage: 'analyzeLane(input.laneLines)',
  },
  {
    id: 'speed-feedforward',
    title: 'Speed Feedforward',
    category: 'Control',
    description: 'The motor needed to hold a speed against drag. Add a PID to correct whatever the estimate gets wrong, like wind.',
    usage: 'speedFeedforward(input.ego.speed)',
  },
  {
    id: 'steering-feedforward',
    title: 'Steering Feedforward',
    category: 'Control',
    description: 'The steering needed to follow the curve ahead. Add it to your lane PID so the PID only has to correct the drift.',
    usage: 'steeringFeedforward(lane.curvature, input.ego.speed)',
    build: (source) => ({ usage: `steeringFeedforward(${laneField(source, 'curvature')}, input.ego.speed)` }),
  },
  {
    id: 'lateral-velocity',
    title: 'Lateral Velocity Steering',
    category: 'Control',
    description: 'Steers so the car slides sideways at the speed you ask for (m/s, positive is right). Pick that speed yourself, for example with a PID on how far you are from the lane center.',
    usage: 'lateralVelocitySteering(input, 0)',
  },
  {
    id: 'adaptive-cruise',
    title: 'Adaptive Cruise Snippet',
    category: 'Following',
    description: 'A target speed: your cruise speed, or slower when the car ahead is inside the following gap. Drive it with speed feedforward plus a speed PID.',
    usage: 'adaptiveCruiseTargetSpeed(input, 29)',
  },
  {
    id: 'fastest-lane',
    title: 'Fastest Lane Selection',
    category: 'Planning',
    description:
      'Picks an adjacent lane whose traffic is at least a minimum speed faster, and holds it until the lane change finishes. Returns the lane to steer for: -1 left, 0 current, 1 right.',
    setup: [`// Only switch when the other lane is at least 3 m/s faster.
const laneChooser = createLaneChooser({ minSpeedGain: 3 });`],
    usage: 'laneChooser.update(input)',
  },
];
