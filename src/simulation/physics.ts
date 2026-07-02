import type { SanitizedAutopilotOutput } from '../types';
import { clamp, normalizeAngle } from './math';
import type { Road } from './road';
import type { VehicleState } from './vehicle';
import type { SeededRandom } from './random';

const MAX_FORWARD_ACCEL = 4.5;
const MAX_BRAKE_ACCEL = 8.5;
const TOP_SPEED = 58;
const MOTOR_TAU = 0.22;
const STEERING_TAU = 0.14;

export function applyVehiclePhysics(
  vehicle: VehicleState,
  road: Road,
  output: SanitizedAutopilotOutput,
  dt: number,
  rng: SeededRandom,
  actuatorVariation: boolean,
): void {
  vehicle.commandMotor = output.motor;
  vehicle.commandSteering = output.steering;
  vehicle.targetLane = output.targetLane;

  const motorNoise = actuatorVariation ? rng.range(-0.035, 0.035) : 0;
  const steeringNoise = actuatorVariation ? rng.range(-0.025, 0.025) : 0;
  const desiredMotor = clamp(output.motor + motorNoise, -1, 1);
  const desiredSteering = clamp(output.steering + steeringNoise, -1, 1);

  const motorAlpha = clamp(dt / MOTOR_TAU, 0, 1);
  const steeringAlpha = clamp(dt / STEERING_TAU, 0, 1);
  vehicle.actualMotor += (desiredMotor - vehicle.actualMotor) * motorAlpha;
  vehicle.actualSteering += (desiredSteering - vehicle.actualSteering) * steeringAlpha;

  const speedRatio = clamp(vehicle.speed / TOP_SPEED, 0, 1);
  const driveAccel =
    vehicle.actualMotor >= 0
      ? vehicle.actualMotor * MAX_FORWARD_ACCEL * (1 - speedRatio ** 1.65)
      : vehicle.actualMotor * MAX_BRAKE_ACCEL;
  const dragAccel = 0.00085 * vehicle.speed * vehicle.speed + 0.012 * vehicle.speed;
  const accel = driveAccel - dragAccel;

  vehicle.speed = Math.max(0, vehicle.speed + accel * dt);

  const roadSample = road.sampleAt(vehicle.s);
  const speedSteeringScale = clamp(vehicle.speed / 22, 0.08, 1);
  const yawRate = vehicle.actualSteering * (0.68 * speedSteeringScale);
  const forwardDelta = vehicle.speed * Math.cos(vehicle.headingOffset) * dt;
  const lateralDelta = vehicle.speed * Math.sin(vehicle.headingOffset) * dt;

  vehicle.s += Math.max(0, forwardDelta);
  vehicle.lateral += lateralDelta;
  vehicle.headingOffset = normalizeAngle(vehicle.headingOffset + yawRate * dt - roadSample.curvature * forwardDelta);

  const roadLimit = Math.max(0.1, road.getRoadHalfWidth() - vehicle.width / 2 - 0.03);
  if (vehicle.lateral < -roadLimit) {
    vehicle.lateral = -roadLimit;
    vehicle.headingOffset = Math.max(vehicle.headingOffset, 0.03);
    vehicle.speed *= 0.985;
  } else if (vehicle.lateral > roadLimit) {
    vehicle.lateral = roadLimit;
    vehicle.headingOffset = Math.min(vehicle.headingOffset, -0.03);
    vehicle.speed *= 0.985;
  }

  vehicle.headingOffset = clamp(vehicle.headingOffset, -0.95, 0.95);
  vehicle.laneIndex = road.getLaneIndex(vehicle.lateral);
}
