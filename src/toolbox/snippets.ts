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
    setup: [lanePidSetup],
    usage: `const steering = lanePid.update(laneError, input.dt);`,
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
