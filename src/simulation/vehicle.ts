import type { TrafficPersonalityInstance } from './personalities';

export type VehicleKind = 'ego' | 'traffic';

export interface VehicleState {
  id: string;
  kind: VehicleKind;
  s: number;
  lateral: number;
  headingOffset: number;
  speed: number;
  laneIndex: number;
  targetLane: number;
  desiredSpeed: number;
  width: number;
  length: number;
  color: string;
  actualMotor: number;
  actualSteering: number;
  commandMotor: number;
  commandSteering: number;
  laneChangeCooldown: number;
  collision: boolean;
  personality?: TrafficPersonalityInstance;
}

export interface AppliedControls {
  userMotor: number;
  userSteering: number;
  finalMotor: number;
  finalSteering: number;
  actualMotor: number;
  actualSteering: number;
  targetLane: number;
  steerOverridden: boolean;
  motorOverridden: boolean;
  invalidFields: string[];
}
