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
  /** Lane traffic is steering toward. Players don't declare one, so for them it tracks laneIndex. */
  targetLane: number;
  /**
   * Players only: the last lane they were settled in (near its center and
   * heading along the road). Collision blame measures drift from this lane, so
   * crossing into another lane doesn't make it the player's lane until they settle there.
   */
  settledLane?: number;
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
  /** Set by physics: the body was pushed back from the road edge on the latest step. */
  edgeContact?: boolean;
  /** Traffic only: 0-1 fade on in-lane weaving, held at 0 during lane changes. */
  weaveBlend?: number;
  personality?: TrafficPersonalityInstance;
}

export interface AppliedControls {
  userMotor: number;
  userSteering: number;
  finalMotor: number;
  finalSteering: number;
  actualMotor: number;
  actualSteering: number;
  steerOverridden: boolean;
  motorOverridden: boolean;
  invalidFields: string[];
}
