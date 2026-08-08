import {
  accelerationFeedforwardImplementation,
  adaptiveCruiseImplementation,
  clampImplementation,
  curveRegressionImplementation,
  laneInterpretationImplementation,
  pidControllerImplementation,
  vehicleFilteringImplementation,
  vehicleTrackerImplementation,
} from './library';

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
    implementation: clampImplementation,
    usage: `const safeSteering = clamp(steering, -1, 1);
const safeMotor = clamp(motor, -1, 1);`,
  },
  {
    id: 'vehicle-tracker',
    title: 'Kalman Vehicle Tracker',
    category: 'Estimation',
    description: 'Builds stable constant-velocity tracks from intermittent raw vehicle measurements.',
    implementation: vehicleTrackerImplementation,
    usage: `const tracker = createVehicleTracker();

export function autopilot(input: AutopilotInput): AutopilotOutput {
  const myTracks = tracker.update(input.vehicleMeasurements, input.dt);
  const lead = closestVehicleAhead(myTracks, input.ego.laneIndex);
  // Compare myTracks with the built-in input.vehicles tracks.
  return { motor: lead && lead.relativeY < 25 ? -0.2 : 0.3, steering: 0 };
}`,
  },
  {
    id: 'vehicle-filtering',
    title: 'Vehicle Filtering',
    category: 'Perception',
    description: 'Find vehicles in a lane and pick the closest one ahead for following-distance control.',
    implementation: vehicleFilteringImplementation,
    usage: `const leadVehicle = closestVehicleAhead(input.vehicles, input.ego.laneIndex);
const gapMeters = leadVehicle?.relativeY ?? Number.POSITIVE_INFINITY;`,
  },
  {
    id: 'pid-controller',
    title: 'PID Controller Object',
    category: 'Control',
    description: 'A stateful PID controller with integral limiting, output limiting, reset, and optional debug terms.',
    implementation: pidControllerImplementation,
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
    implementation: laneInterpretationImplementation,
    usage: `const lane = analyzeLane(input.laneLines);
const laneError = lane.centerOffset + lane.heading * 2.5;`,
  },
  {
    id: 'feedforward',
    title: 'Acceleration Feedforward',
    category: 'Control',
    description: 'Adds a rough motor estimate for nonlinear acceleration and drag before PID feedback.',
    implementation: accelerationFeedforwardImplementation,
    usage: `const targetSpeed = 28;
const motor = accelerationFeedforward(targetSpeed, input.ego.speed);`,
  },
  {
    id: 'curve-regression',
    title: 'Curve Regression Helper',
    category: 'Perception',
    description:
      'Uses the built-in weighted lane regression helper to estimate center offset, heading, and curvature on sharper turns.',
    implementation: curveRegressionImplementation,
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
    implementation: adaptiveCruiseImplementation,
    usage: `const targetSpeed = adaptiveCruiseTargetSpeed(input, 29);
const motor = speedPid.update(targetSpeed - input.ego.speed, input.dt);`,
  },
];
