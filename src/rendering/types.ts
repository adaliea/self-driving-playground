import type { AutopilotDebug, LaneLineDetections, PlaygroundSettings, VehicleDetection } from '../types';

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
}

export interface RenderCamera {
  x: number;
  y: number;
  heading: number;
}

export interface RenderTelemetry {
  time: number;
  speed: number;
  speedMph: number;
  laneIndex: number;
  targetLane: number;
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
  detections: VehicleDetection[];
  laneLines: LaneLineDetections;
}

export interface RenderSnapshot {
  camera: RenderCamera;
  road: {
    surface: RenderRoadSurface;
    lines: RenderRoadLine[];
  };
  vehicles: RenderVehicle[];
  sensors: RenderSensors;
  telemetry: RenderTelemetry;
  settings: PlaygroundSettings;
}
