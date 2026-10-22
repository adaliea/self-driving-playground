import type { AutopilotDebug, LaneLineDetections, PlaygroundSettings, VehicleMeasurement, VehicleTrack } from '../types';

export interface RenderPoint {
  x: number;
  y: number;
}

export interface RenderRoadLine {
  id: string;
  role: 'outer' | 'lane';
  dashed: boolean;
  dashOffsetMeters: number;
  points: RenderPoint[];
}

export interface RenderRoadSurface {
  left: RenderPoint[];
  right: RenderPoint[];
}

export interface RenderVehicle {
  id: string;
  kind: 'ego' | 'traffic';
  x: number;
  y: number;
  heading: number;
  width: number;
  length: number;
  color: string;
  speed: number;
  laneIndex: number;
  targetLane: number;
  actualMotor: number;
  actualSteering: number;
  commandMotor: number;
  commandSteering: number;
  collision: boolean;
  personality?: string;
}

export type CollisionKind = 'rear-end' | 'sideswipe' | 'corner';

export interface RenderCollisionEvent {
  id: string;
  vehicleIds: [string, string];
  point: RenderPoint;
  kind: CollisionKind;
  egoInvolved: boolean;
  /** Vehicle judged responsible for the contact; undefined when blame is shared. */
  faultVehicleId?: string;
  severity: number;
  age: number;
  duration: number;
}

export interface RenderCamera {
  x: number;
  y: number;
  heading: number;
}

export interface LeadVehicleTelemetry {
  id: string;
  speedMph: number;
  relativeX: number;
  relativeY: number;
  relativeVx: number;
  relativeVy: number;
}

export interface RenderTelemetry {
  leadVehicle?: LeadVehicleTelemetry;
  time: number;
  speed: number;
  speedMph: number;
  laneIndex: number;
  userMotor: number;
  userSteering: number;
  finalMotor: number;
  finalSteering: number;
  actualMotor: number;
  actualSteering: number;
  steerOverridden: boolean;
  motorOverridden: boolean;
  invalidFields: string[];
  collisions: number;
  debug?: AutopilotDebug;
}

export interface RenderSensors {
  measurements: VehicleMeasurement[];
  tracks: VehicleTrack[];
  laneLines: LaneLineDetections;
}

export interface RenderSnapshot {
  camera: RenderCamera;
  road: {
    surface: RenderRoadSurface;
    lines: RenderRoadLine[];
  };
  vehicles: RenderVehicle[];
  collisionEvents: RenderCollisionEvent[];
  sensors: RenderSensors;
  telemetry: RenderTelemetry;
  settings: PlaygroundSettings;
}
