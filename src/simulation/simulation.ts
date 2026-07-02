import type { AutopilotInput, PlaygroundSettings, SanitizedAutopilotOutput } from '../types';
import type { RenderPoint, RenderSnapshot } from '../rendering/types';
import {
  builtInAssistLaneKeeping,
  builtInAssistSpeedControl,
  builtInLaneCentering,
  sanitizeAutopilotOutput,
  trafficAutopilot,
} from './controllers';
import { applyVehiclePhysics } from './physics';
import { Road } from './road';
import { SeededRandom } from './random';
import { SensorSimulator } from './sensors';
import { clamp, metersPerSecondToMph, round } from './math';
import type { AppliedControls, VehicleState } from './vehicle';
import { createTrafficPersonality, type TrafficPersonalityInstance } from './personalities';

const EGO_ID = 'ego';
const TRAFFIC_COLORS = ['#a9bed0', '#d7dde3', '#8ea6ff', '#f0b56a', '#82dec1'];
const TRAFFIC_MIN_COUNT = 10;
const TRAFFIC_MAX_COUNT = 132;
const TRAFFIC_BACK_BUFFER = 250;
const TRAFFIC_FRONT_BUFFER = 820;
const TRAFFIC_MIN_SPAWN_GAP = 10;
const COLLISION_LENGTH_INSET = 0.18;
const COLLISION_WIDTH_INSET = 0.12;
const COLLISION_VISUAL_OVERLAP = 0.08;

export interface SimulationVehicleDebug {
  id: string;
  kind: 'ego' | 'traffic';
  s: number;
  lateral: number;
  headingOffset: number;
  speed: number;
  width: number;
  length: number;
  laneIndex: number;
  targetLane: number;
  desiredSpeed: number;
  actualSteering: number;
  commandSteering: number;
  collision: boolean;
  personality?: string;
  laneControlModel?: string;
}

export interface SimulationDebugState {
  time: number;
  collisions: number;
  vehicles: SimulationVehicleDebug[];
}

interface CollisionAxis {
  x: number;
  y: number;
}

interface CollisionRect {
  center: CollisionAxis;
  forward: CollisionAxis;
  right: CollisionAxis;
  halfLength: number;
  halfWidth: number;
}

export class Simulation {
  private road: Road;
  private rng: SeededRandom;
  private readonly sensors = new SensorSimulator();
  private vehicles: VehicleState[] = [];
  private time = 0;
  private collisions = 0;
  private egoCollisionActive = false;
  private lastEgoInput: AutopilotInput;
  private lastApplied: AppliedControls = {
    userMotor: 0,
    userSteering: 0,
    finalMotor: 0,
    finalSteering: 0,
    actualMotor: 0,
    actualSteering: 0,
    targetLane: 1,
    steerOverridden: false,
    motorOverridden: false,
    invalidFields: [],
  };
  private lastUserOutput: SanitizedAutopilotOutput = {
    motor: 0,
    steering: 0,
    targetLane: 1,
    invalidFields: [],
  };

  constructor(settings: PlaygroundSettings) {
    this.road = new Road(settings.seed);
    this.rng = new SeededRandom(settings.seed);
    this.reset(settings);
    this.lastEgoInput = this.createEgoInput(settings, 1 / 45);
  }

  reset(settings: PlaygroundSettings): void {
    this.road = new Road(settings.seed);
    this.rng = new SeededRandom(settings.seed);
    this.sensors.reset();
    this.time = 0;
    this.collisions = 0;
    this.egoCollisionActive = false;

    const egoLane = 1;
    this.vehicles = [
      {
        id: EGO_ID,
        kind: 'ego',
        s: 120,
        lateral: this.road.getLaneCenterOffset(egoLane),
        headingOffset: 0,
        speed: settings.startingSpeed,
        laneIndex: egoLane,
        targetLane: egoLane,
        desiredSpeed: 29,
        width: 2.05,
        length: 4.65,
        color: '#f7fffb',
        actualMotor: 0,
        actualSteering: 0,
        commandMotor: 0,
        commandSteering: 0,
        laneChangeCooldown: 0,
        collision: false,
      },
    ];

    this.seedTraffic(settings);
    this.lastEgoInput = this.createEgoInput(settings, 1 / 45);
    this.lastApplied = {
      userMotor: 0,
      userSteering: 0,
      finalMotor: 0,
      finalSteering: 0,
      actualMotor: 0,
      actualSteering: 0,
      targetLane: egoLane,
      steerOverridden: false,
      motorOverridden: false,
      invalidFields: [],
    };
    this.lastUserOutput = {
      motor: 0,
      steering: 0,
      targetLane: egoLane,
      invalidFields: [],
    };
  }

  createEgoInput(settings: PlaygroundSettings, dt: number): AutopilotInput {
    this.lastEgoInput = this.sensors.createInput(this.ego, this.vehicles, this.road, settings, this.rng, dt);
    return this.lastEgoInput;
  }

  step(dt: number, rawUserOutput: unknown, settings: PlaygroundSettings): void {
    this.time += dt;
    this.road.extendTo(this.ego.s + 700);
    this.ensureTrafficCount(settings);

    const ego = this.ego;
    const user = sanitizeAutopilotOutput(rawUserOutput, ego.targetLane, this.road.laneCount);
    ego.targetLane = user.targetLane;

    const assistMotor = builtInAssistSpeedControl(this.lastEgoInput, Math.max(ego.desiredSpeed, 31));
    const assistSteering = builtInAssistLaneKeeping(this.lastEgoInput);
    const finalOutput: SanitizedAutopilotOutput = {
      ...user,
      motor: settings.accelerateAssist ? assistMotor : user.motor,
      steering: settings.steerAssist ? assistSteering : user.steering,
      targetLane: user.targetLane,
    };

    applyVehiclePhysics(ego, this.road, finalOutput, dt, this.rng, settings.actuatorVariation);
    this.lastUserOutput = user;
    this.lastApplied = {
      userMotor: user.motor,
      userSteering: user.steering,
      finalMotor: finalOutput.motor,
      finalSteering: finalOutput.steering,
      actualMotor: ego.actualMotor,
      actualSteering: ego.actualSteering,
      targetLane: ego.targetLane,
      steerOverridden: settings.steerAssist,
      motorOverridden: settings.accelerateAssist,
      invalidFields: user.invalidFields,
    };

    for (const vehicle of this.vehicles) {
      if (vehicle.kind !== 'traffic') continue;
      vehicle.laneChangeCooldown = Math.max(0, vehicle.laneChangeCooldown - dt);
      const input = this.sensors.createTrafficInput(vehicle, this.vehicles, this.road, this.rng, dt);
      const trafficRaw = trafficAutopilot(vehicle, input, this.road.laneCount);
      const traffic = sanitizeAutopilotOutput(trafficRaw, vehicle.targetLane, this.road.laneCount);
      vehicle.targetLane = traffic.targetLane;
      const finalTraffic = {
        ...traffic,
        steering: builtInLaneCentering(vehicle, this.road, traffic.targetLane),
      };
      applyVehiclePhysics(vehicle, this.road, finalTraffic, dt, this.rng, settings.actuatorVariation);
    }

    this.resolveCloseVehicles();
    this.recycleTraffic(settings);
  }

  getSnapshot(settings: PlaygroundSettings): RenderSnapshot {
    const egoPose = this.road.worldPointAt(this.ego.s, this.ego.lateral);
    const cameraHeading = egoPose.heading + this.ego.headingOffset;
    const startS = Math.max(0, this.ego.s - 75);
    const endS = this.ego.s + 190;
    this.road.extendTo(endS + 50);

    return {
      camera: {
        x: egoPose.x,
        y: egoPose.y,
        heading: cameraHeading,
      },
      road: {
        surface: {
          left: this.sampleBoundaryPoints(0, startS, endS, 5),
          right: this.sampleBoundaryPoints(this.road.laneCount, startS, endS, 5),
        },
        lines: Array.from({ length: this.road.laneCount + 1 }, (_, boundary) => ({
          id: `boundary-${boundary}`,
          role: boundary === 0 || boundary === this.road.laneCount ? ('outer' as const) : ('lane' as const),
          dashed: boundary > 0 && boundary < this.road.laneCount,
          dashOffsetMeters: startS,
          points: this.sampleBoundaryPoints(boundary, startS, endS, 4),
        })),
      },
      vehicles: this.vehicles.map((vehicle) => {
        const pose = this.road.worldPointAt(vehicle.s, vehicle.lateral);
        return {
          id: vehicle.id,
          kind: vehicle.kind,
          x: pose.x,
          y: pose.y,
          heading: pose.heading + vehicle.headingOffset,
          width: vehicle.width,
          length: vehicle.length,
          color: vehicle.color,
          speed: vehicle.speed,
          laneIndex: vehicle.laneIndex,
          targetLane: vehicle.targetLane,
          actualMotor: vehicle.actualMotor,
          actualSteering: vehicle.actualSteering,
          commandMotor: vehicle.commandMotor,
          commandSteering: vehicle.commandSteering,
          collision: vehicle.collision,
          personality: vehicle.personality?.label,
        };
      }),
      sensors: {
        detections: this.lastEgoInput.vehicles,
        laneLines: this.lastEgoInput.laneLines,
      },
      telemetry: {
        time: this.time,
        speed: this.ego.speed,
        speedMph: metersPerSecondToMph(this.ego.speed),
        laneIndex: this.ego.laneIndex,
        targetLane: this.ego.targetLane,
        userMotor: this.lastApplied.userMotor,
        userSteering: this.lastApplied.userSteering,
        finalMotor: this.lastApplied.finalMotor,
        finalSteering: this.lastApplied.finalSteering,
        actualMotor: this.ego.actualMotor,
        actualSteering: this.ego.actualSteering,
        steerOverridden: this.lastApplied.steerOverridden,
        motorOverridden: this.lastApplied.motorOverridden,
        invalidFields: this.lastApplied.invalidFields,
        collisions: this.collisions,
        debug: this.lastUserOutput.debug,
      },
      settings,
    };
  }

  getDebugState(): SimulationDebugState {
    return {
      time: this.time,
      collisions: this.collisions,
      vehicles: this.vehicles.map((vehicle) => ({
        id: vehicle.id,
        kind: vehicle.kind,
        s: vehicle.s,
        lateral: vehicle.lateral,
        headingOffset: vehicle.headingOffset,
        speed: vehicle.speed,
        width: vehicle.width,
        length: vehicle.length,
        laneIndex: vehicle.laneIndex,
        targetLane: vehicle.targetLane,
        desiredSpeed: vehicle.desiredSpeed,
        actualSteering: vehicle.actualSteering,
        commandSteering: vehicle.commandSteering,
        collision: vehicle.collision,
        personality: vehicle.personality?.label,
        laneControlModel: vehicle.personality?.laneControlModel,
      })),
    };
  }

  private get ego(): VehicleState {
    const ego = this.vehicles.find((vehicle) => vehicle.id === EGO_ID);
    if (!ego) throw new Error('Ego vehicle is missing from the simulation.');
    return ego;
  }

  private seedTraffic(settings: PlaygroundSettings): void {
    const count = this.targetTrafficCount(settings);
    const spacing = this.trafficSpacing(settings);
    let index = 0;

    for (let lane = 0; lane < this.road.laneCount && index < count; lane += 1) {
      let station = this.ego.s - TRAFFIC_BACK_BUFFER + this.rng.range(0, spacing);
      while (station < this.ego.s + TRAFFIC_FRONT_BUFFER && index < count) {
        if (Math.abs(station - this.ego.s) > 26) {
          this.vehicles.push(this.createTrafficVehicle(index, lane, station, settings));
          index += 1;
        }
        station += spacing * this.rng.range(0.72, 1.28);
      }
    }

    while (index < count) {
      const lane = index % this.road.laneCount;
      const station = this.findOpenSpawnStation(lane, settings, true);
      this.vehicles.push(this.createTrafficVehicle(index, lane, station, settings));
      index += 1;
    }
  }

  private ensureTrafficCount(settings: PlaygroundSettings): void {
    const targetCount = this.targetTrafficCount(settings);
    const currentCount = this.vehicles.filter((vehicle) => vehicle.kind === 'traffic').length;
    if (currentCount < targetCount) {
      for (let index = currentCount; index < targetCount; index += 1) {
        const lane = this.rng.int(0, this.road.laneCount - 1);
        this.vehicles.push(
          this.createTrafficVehicle(
            1000 + index + Math.round(this.time * 10),
            lane,
            this.findOpenSpawnStation(lane, settings, true),
            settings,
          ),
        );
      }
    } else if (currentCount > targetCount) {
      const removable = this.vehicles
        .filter((vehicle) => vehicle.kind === 'traffic')
        .sort((a, b) => Math.abs(b.s - this.ego.s) - Math.abs(a.s - this.ego.s))
        .slice(0, currentCount - targetCount)
        .map((vehicle) => vehicle.id);
      this.vehicles = this.vehicles.filter((vehicle) => !removable.includes(vehicle.id));
    }
  }

  private recycleTraffic(settings: PlaygroundSettings): void {
    for (const vehicle of this.vehicles) {
      if (vehicle.kind !== 'traffic') continue;
      if (vehicle.s < this.ego.s - TRAFFIC_BACK_BUFFER || vehicle.s > this.ego.s + TRAFFIC_FRONT_BUFFER) {
        const lane = this.rng.int(0, this.road.laneCount - 1);
        vehicle.s = this.findOpenSpawnStation(lane, settings, vehicle.s < this.ego.s);
        vehicle.lateral = this.road.getLaneCenterOffset(lane);
        vehicle.laneIndex = lane;
        vehicle.targetLane = lane;
        vehicle.headingOffset = this.rng.range(-0.02, 0.02);
        vehicle.personality = this.createPersonality(settings);
        vehicle.speed = this.trafficInitialSpeed(vehicle.personality);
        vehicle.desiredSpeed = this.trafficDesiredSpeed(vehicle.personality, settings);
        vehicle.actualMotor = 0;
        vehicle.actualSteering = 0;
        vehicle.collision = false;
      }
    }
  }

  private createTrafficVehicle(index: number, lane: number, station: number, settings: PlaygroundSettings): VehicleState {
    const personality = this.createPersonality(settings);
    return {
      id: `traffic-${index}-${Math.round(station)}`,
      kind: 'traffic',
      s: station,
      lateral: this.road.getLaneCenterOffset(lane) + this.rng.range(-0.25, 0.25),
      headingOffset: this.rng.range(-0.025, 0.025),
      speed: this.trafficInitialSpeed(personality),
      laneIndex: lane,
      targetLane: lane,
      desiredSpeed: this.trafficDesiredSpeed(personality, settings),
      width: personality.id === 'truck' ? this.rng.range(2.25, 2.55) : this.rng.range(1.85, 2.25),
      length: personality.id === 'truck' ? this.rng.range(6.8, 8.8) : this.rng.range(4.1, 5.2),
      color: personality.color ?? TRAFFIC_COLORS[index % TRAFFIC_COLORS.length],
      actualMotor: 0,
      actualSteering: 0,
      commandMotor: 0,
      commandSteering: 0,
      laneChangeCooldown: this.rng.range(0, 4),
      collision: false,
      personality,
    };
  }

  private resolveCloseVehicles(): void {
    for (const vehicle of this.vehicles) vehicle.collision = false;
    let egoCollisionThisStep = false;
    const sortedVehicles = [...this.vehicles].sort((a, b) => a.s - b.s);

    for (let behindIndex = 0; behindIndex < sortedVehicles.length; behindIndex += 1) {
      const behind = sortedVehicles[behindIndex];
      for (let aheadIndex = behindIndex + 1; aheadIndex < sortedVehicles.length; aheadIndex += 1) {
        const ahead = sortedVehicles[aheadIndex];
        const gap = ahead.s - behind.s;
        const maxRelevantGap = (behind.length + ahead.length) / 2 + 3.5;
        if (gap > maxRelevantGap) break;

        const lateralGap = Math.abs(ahead.lateral - behind.lateral);
        const bodyHalfWidth = (behind.width + ahead.width) / 2;
        const bodyHalfLength = (behind.length + ahead.length) / 2;
        const sameTravelPath = lateralGap < bodyHalfWidth + 0.35;
        if (!sameTravelPath) continue;

        const bodiesOverlap = gap < bodyHalfLength && this.vehicleBodiesOverlap(behind, ahead);
        if (bodiesOverlap) {
          behind.collision = true;
          ahead.collision = true;
          if (behind.kind === 'ego' || ahead.kind === 'ego') egoCollisionThisStep = true;
          behind.s = Math.min(behind.s, ahead.s - Math.max(0.1, bodyHalfLength - COLLISION_VISUAL_OVERLAP));
          behind.speed = Math.min(behind.speed, ahead.speed * 0.96);
          continue;
        }

        const softFollowingGap = bodyHalfLength + 1.05;
        if (gap < softFollowingGap) {
          behind.s = Math.min(behind.s, ahead.s - softFollowingGap);
          behind.speed = Math.min(behind.speed, ahead.speed * 0.985);
        }
      }
    }

    if (egoCollisionThisStep && !this.egoCollisionActive) this.collisions += 1;
    this.egoCollisionActive = egoCollisionThisStep;
  }

  private vehicleBodiesOverlap(a: VehicleState, b: VehicleState): boolean {
    const rectA = this.vehicleCollisionRect(a);
    const rectB = this.vehicleCollisionRect(b);
    const axes = [rectA.forward, rectA.right, rectB.forward, rectB.right];

    for (const axis of axes) {
      const projectionA = projectCollisionRect(rectA, axis);
      const projectionB = projectCollisionRect(rectB, axis);
      if (projectionA.max < projectionB.min || projectionB.max < projectionA.min) return false;
    }

    return true;
  }

  private vehicleCollisionRect(vehicle: VehicleState): CollisionRect {
    const pose = this.road.worldPointAt(vehicle.s, vehicle.lateral);
    const heading = pose.heading + vehicle.headingOffset;
    return {
      center: { x: pose.x, y: pose.y },
      forward: { x: Math.sin(heading), y: Math.cos(heading) },
      right: { x: Math.cos(heading), y: -Math.sin(heading) },
      halfLength: Math.max(0.1, vehicle.length / 2 - COLLISION_LENGTH_INSET),
      halfWidth: Math.max(0.1, vehicle.width / 2 - COLLISION_WIDTH_INSET),
    };
  }

  private targetTrafficCount(settings: PlaygroundSettings): number {
    const density = clamp(settings.trafficDensity, 0, 1);
    return Math.round(TRAFFIC_MIN_COUNT + density ** 1.28 * (TRAFFIC_MAX_COUNT - TRAFFIC_MIN_COUNT));
  }

  private trafficSpacing(settings: PlaygroundSettings): number {
    const density = clamp(settings.trafficDensity, 0, 1);
    return 58 - density * 45;
  }

  private createPersonality(settings: PlaygroundSettings): TrafficPersonalityInstance {
    return createTrafficPersonality(this.rng, settings.trafficDensity);
  }

  private trafficDesiredSpeed(personality: TrafficPersonalityInstance, settings: PlaygroundSettings): number {
    const density = clamp(settings.trafficDensity, 0, 1);
    if (density > 0.72 && this.rng.chance(0.16 + (density - 0.72) * 0.6)) {
      return this.rng.range(9, 17);
    }
    return this.rng.range(personality.desiredSpeedMin - density * 2.2, personality.desiredSpeedMax - density * 4);
  }

  private trafficInitialSpeed(personality: TrafficPersonalityInstance): number {
    const desired = this.rng.range(personality.desiredSpeedMin, personality.desiredSpeedMax);
    return clamp(desired + this.rng.range(-3.5, 3.5), 6, 38);
  }

  private findOpenSpawnStation(lane: number, settings: PlaygroundSettings, preferAhead: boolean): number {
    const minS = this.ego.s - TRAFFIC_BACK_BUFFER;
    const maxS = this.ego.s + TRAFFIC_FRONT_BUFFER;
    const minGap = Math.max(TRAFFIC_MIN_SPAWN_GAP, this.trafficSpacing(settings) * 0.62);
    const laneVehicles = this.vehicles
      .filter((vehicle) => vehicle.kind === 'traffic' && vehicle.laneIndex === lane)
      .map((vehicle) => vehicle.s)
      .sort((a, b) => a - b);

    const randomMin = preferAhead ? this.ego.s + 170 : minS;
    const randomMax = preferAhead ? maxS : this.ego.s - 80;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = this.rng.range(randomMin, randomMax);
      if (Math.abs(candidate - this.ego.s) < 28) continue;
      if (laneVehicles.every((station) => Math.abs(station - candidate) >= minGap)) return candidate;
    }

    const bounds = [minS, ...laneVehicles.filter((station) => station >= minS && station <= maxS), maxS];
    let bestStation = preferAhead ? this.ego.s + 180 : this.ego.s - 120;
    let bestGap = 0;
    for (let index = 1; index < bounds.length; index += 1) {
      const gap = bounds[index] - bounds[index - 1];
      const midpoint = (bounds[index] + bounds[index - 1]) / 2;
      if (gap > bestGap && Math.abs(midpoint - this.ego.s) > 28) {
        bestGap = gap;
        bestStation = midpoint;
      }
    }

    return clamp(bestStation, minS, maxS);
  }

  private sampleBoundaryPoints(boundary: number, startS: number, endS: number, spacing: number): RenderPoint[] {
    const points: RenderPoint[] = [];
    for (let station = startS; station <= endS; station += spacing) {
      const point = this.road.worldPointAt(station, this.road.getBoundaryOffset(boundary));
      points.push({
        x: round(point.x, 3),
        y: round(point.y, 3),
      });
    }
    return points;
  }
}

function projectCollisionRect(rect: CollisionRect, axis: CollisionAxis): { min: number; max: number } {
  const center = rect.center.x * axis.x + rect.center.y * axis.y;
  const radius =
    Math.abs(rect.forward.x * axis.x + rect.forward.y * axis.y) * rect.halfLength +
    Math.abs(rect.right.x * axis.x + rect.right.y * axis.y) * rect.halfWidth;

  return {
    min: center - radius,
    max: center + radius,
  };
}
