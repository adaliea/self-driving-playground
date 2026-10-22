import type { AutopilotInput, PlaygroundSettings, SanitizedAutopilotOutput } from '../types';
import type { CollisionKind, RenderCollisionEvent, RenderPoint, RenderSnapshot } from '../rendering/types';
import {
  builtInAssistLaneKeeping,
  builtInAssistSpeedControl,
  closestVehicleAhead,
  builtInLaneCentering,
  sanitizeAutopilotOutput,
  trafficAutopilot,
} from './controllers';
import { applyVehiclePhysics, roadEdgeLimit } from './physics';
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
const TRAFFIC_MAX_SCALED_COUNT = 240;
// A player counts as settled in a lane, for collision blame, once this close to its center and this aligned with the road.
const SETTLED_LANE_OFFSET = 0.42;
const SETTLED_LANE_HEADING = 0.07;
const COLLISION_POSITION_SLOP = 0.015;
const COLLISION_MAX_CORRECTION = 0.55;
const COLLISION_FEEDBACK_DURATION = 0.95;
const COLLISION_EVENT_COOLDOWN = 0.7;
const COLLISION_REPEAT_IMPACT_SPEED = 0.04;
const COLLISION_CONTACT_VISUAL_HOLD = 0.18;
// After an edge hit, a player must pull this far back from the edge before touching it again counts as a new hit.
const EDGE_HIT_REARM_DISTANCE = 0.3;
// Weaving keeps this much space between the body and the lane lines.
const WEAVE_LANE_MARGIN = 0.2;
// In an outer lane, weaving toward the road edge keeps this much more space, since curves add tracking error.
const WEAVE_EDGE_MARGIN = 0.5;
// Per second: weaving fades in slowly after a lane change and drops out quickly when one starts.
// Lane drifters wander this far (peak meters) and can put this much of their body over the lane line.
const LANE_DRIFT_AMPLITUDE = 1.1;
const LANE_DRIFT_OVER_LINE = 0.5;
// Drifters wander this much slower than their personality's weave period.
const LANE_DRIFT_PERIOD_SCALE = 1.5;
// A drifter only crosses into an adjacent lane with no vehicle within this many meters along the road,
// plus extra for the speed difference.
const LANE_DRIFT_CLEAR_DISTANCE = 18;
const LANE_DRIFT_CLEAR_SECONDS = 1.5;
const WEAVE_FADE_IN_RATE = 0.35;
const WEAVE_FADE_OUT_RATE = 2;
const FAULT_LATERAL_SPEED_THRESHOLD = 0.35;
const CUT_IN_LATERAL_SPEED_THRESHOLD = 0.8;
const DEFAULT_PLAYER: SimulationPlayer = { id: EGO_ID, color: '#f7fffb' };
const GRID_ROW_SPACING = 30;
const GRID_FRONT_S = 120;

export interface SimulationPlayer {
  id: string;
  color?: string;
}

export interface SimulationOptions {
  /** Ego vehicles driven by autopilot code. Defaults to the single `ego` vehicle. */
  players?: SimulationPlayer[];
  /** Seconds of forced coasting after a player causes a collision. Disabled by default. */
  atFaultStallSeconds?: number;
  /**
   * Meters of traffic kept behind the rearmost player and ahead of the frontmost. Traffic count scales with
   * the window, so a smaller window keeps the same density with fewer cars to simulate. New traffic
   * spawns 170 m or more ahead, so `ahead` must be well above that.
   */
  trafficWindow?: { behind: number; ahead: number };
}

export interface SimulationViewOptions {
  /** Road station used as the camera center. Defaults to the focused player. */
  centerS?: number;
  behindMeters?: number;
  aheadMeters?: number;
  /** Player whose sensors and telemetry are included. Defaults to the first player. */
  focusId?: string;
  /** Road-frame poses that override vehicle positions, e.g. interpolated between steps for smooth rendering. */
  poses?: ReadonlyMap<string, VehicleFrame>;
}

/** Vehicle pose in road coordinates. */
export interface VehicleFrame {
  s: number;
  lateral: number;
  headingOffset: number;
}

export interface PlayerRaceState {
  id: string;
  distance: number;
  s: number;
  speed: number;
  laneIndex: number;
  collisions: number;
  atFaultCollisions: number;
  /** Separate times the player's car hit the road edge. */
  edgeHits: number;
  stalled: boolean;
}

interface PlayerRuntime {
  id: string;
  startS: number;
  lastInput?: AutopilotInput;
  lastApplied: AppliedControls;
  lastUserOutput: SanitizedAutopilotOutput;
  collisions: number;
  atFaultCollisions: number;
  edgeHits: number;
  /** False after an edge hit until the car pulls back from the edge. */
  edgeHitArmed: boolean;
  stallUntil: number;
}

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
  edgeContact: boolean;
  personality?: string;
  laneDrifter: boolean;
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

interface CollisionContact {
  normal: CollisionAxis;
  penetration: number;
}

interface CollisionEventState extends Omit<RenderCollisionEvent, 'age'> {
  startedAt: number;
}

export class Simulation {
  private road: Road;
  private rng: SeededRandom;
  private readonly sensors = new SensorSimulator();
  private vehicles: VehicleState[] = [];
  private time = 0;
  private collisions = 0;
  private collisionSequence = 0;
  private collisionEvents: CollisionEventState[] = [];
  private activeCollisionPairs = new Set<string>();
  private collisionPairLastStarted = new Map<string, number>();
  private collisionVisualUntil = new Map<string, number>();
  private readonly players: SimulationPlayer[];
  private readonly atFaultStallSeconds: number;
  private readonly trafficBehind: number;
  private readonly trafficAhead: number;
  private playerRuntimes = new Map<string, PlayerRuntime>();

  constructor(settings: PlaygroundSettings, options: SimulationOptions = {}) {
    this.players = options.players?.length ? options.players : [DEFAULT_PLAYER];
    this.atFaultStallSeconds = Math.max(0, options.atFaultStallSeconds ?? 0);
    this.trafficBehind = options.trafficWindow?.behind ?? TRAFFIC_BACK_BUFFER;
    this.trafficAhead = options.trafficWindow?.ahead ?? TRAFFIC_FRONT_BUFFER;
    this.road = new Road(settings.seed);
    this.rng = new SeededRandom(settings.seed);
    this.reset(settings);
    for (const player of this.players) this.createPlayerInput(player.id, settings, 1 / 45);
  }

  reset(settings: PlaygroundSettings): void {
    this.road = new Road(settings.seed);
    this.rng = new SeededRandom(settings.seed);
    this.sensors.reset();
    this.time = 0;
    this.collisions = 0;
    this.collisionSequence = 0;
    this.collisionEvents = [];
    this.activeCollisionPairs.clear();
    this.collisionPairLastStarted.clear();
    this.collisionVisualUntil.clear();

    // Players start on a grid: one car per lane per row, rows spaced to give a safe headway.
    const laneOrder = [1, 0, 2].filter((lane) => lane < this.road.laneCount);
    const rows = Math.ceil(this.players.length / laneOrder.length);
    this.vehicles = [];
    this.playerRuntimes = new Map();
    this.players.forEach((player, index) => {
      const lane = laneOrder[index % laneOrder.length];
      const s = GRID_FRONT_S + (rows - 1 - Math.floor(index / laneOrder.length)) * GRID_ROW_SPACING;
      this.vehicles.push({
        id: player.id,
        kind: 'ego',
        s,
        lateral: this.road.getLaneCenterOffset(lane),
        headingOffset: 0,
        speed: settings.startingSpeed,
        laneIndex: lane,
        targetLane: lane,
        settledLane: lane,
        desiredSpeed: 29,
        width: 2.05,
        length: 4.65,
        color: player.color ?? DEFAULT_PLAYER.color!,
        actualMotor: 0,
        actualSteering: 0,
        commandMotor: 0,
        commandSteering: 0,
        laneChangeCooldown: 0,
        collision: false,
      });
      this.playerRuntimes.set(player.id, {
        id: player.id,
        startS: s,
        lastApplied: idleAppliedControls(),
        lastUserOutput: { motor: 0, steering: 0, invalidFields: [] },
        collisions: 0,
        atFaultCollisions: 0,
        edgeHits: 0,
        edgeHitArmed: true,
        stallUntil: 0,
      });
    });

    this.seedTraffic(settings);
    for (const player of this.players) this.createPlayerInput(player.id, settings, 1 / 45);
  }

  /** Player ids in grid order. */
  get playerIds(): string[] {
    return this.players.map((player) => player.id);
  }

  createEgoInput(settings: PlaygroundSettings, dt: number): AutopilotInput {
    return this.createPlayerInput(this.primaryId, settings, dt);
  }

  createPlayerInput(id: string, settings: PlaygroundSettings, dt: number): AutopilotInput {
    const runtime = this.playerRuntime(id);
    runtime.lastInput = this.sensors.createInput(this.playerVehicle(id), this.vehicles, this.road, settings, this.rng, dt);
    return runtime.lastInput;
  }

  step(dt: number, rawUserOutput: unknown, settings: PlaygroundSettings): void {
    this.stepPlayers(dt, new Map([[this.primaryId, rawUserOutput]]), settings);
  }

  /** Advances every vehicle. Players without an entry in `rawOutputs` coast with zero output. */
  stepPlayers(dt: number, rawOutputs: ReadonlyMap<string, unknown>, settings: PlaygroundSettings): void {
    this.time += dt;
    this.road.extendTo(this.maxPlayerS() + 700);
    this.ensureTrafficCount(settings);

    for (const runtime of this.playerRuntimes.values()) {
      const ego = this.playerVehicle(runtime.id);
      const input = runtime.lastInput ?? this.createPlayerInput(runtime.id, settings, dt);
      const user = sanitizeAutopilotOutput(rawOutputs.get(runtime.id));

      const stalled = runtime.stallUntil > this.time;
      const finalOutput: SanitizedAutopilotOutput = {
        ...user,
        motor: stalled
          ? 0
          : settings.accelerateAssist
            ? builtInAssistSpeedControl(input, Math.max(ego.desiredSpeed, 31))
            : user.motor,
        steering: settings.steerAssist ? builtInAssistLaneKeeping(input) : user.steering,
      };

      applyVehiclePhysics(ego, this.road, finalOutput, dt, this.rng, settings.actuatorVariation);
      this.trackEdgeHit(runtime, ego);
      ego.targetLane = ego.laneIndex;
      ego.settledLane = this.settledLaneOf(ego);
      runtime.lastUserOutput = user;
      runtime.lastApplied = {
        userMotor: user.motor,
        userSteering: user.steering,
        finalMotor: finalOutput.motor,
        finalSteering: finalOutput.steering,
        actualMotor: ego.actualMotor,
        actualSteering: ego.actualSteering,
        steerOverridden: settings.steerAssist,
        motorOverridden: settings.accelerateAssist || stalled,
        invalidFields: user.invalidFields,
      };
    }

    for (const vehicle of this.vehicles) {
      if (vehicle.kind !== 'traffic') continue;
      vehicle.laneChangeCooldown = Math.max(0, vehicle.laneChangeCooldown - dt);
      const input = this.sensors.createTrafficInput(vehicle, this.vehicles, this.road, this.rng, dt);
      const trafficRaw = trafficAutopilot(vehicle, input, this.road.laneCount);
      const traffic = sanitizeAutopilotOutput(trafficRaw);
      vehicle.targetLane = clamp(Math.round(trafficRaw.targetLane), 0, this.road.laneCount - 1);
      const finalTraffic = {
        ...traffic,
        steering: builtInLaneCentering(vehicle, this.road, vehicle.targetLane, this.trafficWeaveOffset(vehicle, dt)),
      };
      applyVehiclePhysics(vehicle, this.road, finalTraffic, dt, this.rng, settings.actuatorVariation);
    }

    this.resolveCloseVehicles();
    this.recycleTraffic(settings);
  }

  getSnapshot(settings: PlaygroundSettings, view: SimulationViewOptions = {}): RenderSnapshot {
    const focus = this.playerVehicle(view.focusId ?? this.primaryId);
    const runtime = this.playerRuntime(focus.id);
    const lastInput = runtime.lastInput ?? this.createPlayerInput(focus.id, settings, 1 / 45);
    const centerS = view.centerS ?? focus.s;
    const cameraPose =
      view.centerS === undefined
        ? this.road.worldPointAt(focus.s, focus.lateral)
        : this.road.worldPointAt(centerS, 0);
    const cameraHeading = cameraPose.heading + (view.centerS === undefined ? focus.headingOffset : 0);
    // Custom views snap sampling to a fixed grid so road-side points keep stable world positions.
    const unsnappedStartS = Math.max(0, centerS - (view.behindMeters ?? 75));
    const startS = view.centerS === undefined ? unsnappedStartS : Math.floor(unsnappedStartS / 20) * 20;
    const endS = centerS + (view.aheadMeters ?? 190);
    this.road.extendTo(endS + 50);

    return {
      camera: {
        x: cameraPose.x,
        y: cameraPose.y,
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
        const frame = view.poses?.get(vehicle.id) ?? vehicle;
        const pose = this.road.worldPointAt(frame.s, frame.lateral);
        return {
          id: vehicle.id,
          kind: vehicle.kind,
          x: pose.x,
          y: pose.y,
          heading: pose.heading + frame.headingOffset,
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
          collision: vehicle.collision || (this.collisionVisualUntil.get(vehicle.id) ?? 0) > this.time,
          personality: vehicle.personality?.label,
        };
      }),
      collisionEvents: this.collisionEvents.map(({ startedAt, ...event }) => ({
        ...event,
        age: Math.max(0, this.time - startedAt),
      })),
      sensors: {
        measurements: lastInput.vehicleMeasurements,
        tracks: lastInput.vehicles,
        laneLines: lastInput.laneLines,
      },
      telemetry: {
        leadVehicle: this.getLeadVehicleTelemetry(lastInput),
        time: this.time,
        speed: focus.speed,
        speedMph: metersPerSecondToMph(focus.speed),
        laneIndex: focus.laneIndex,
        userMotor: runtime.lastApplied.userMotor,
        userSteering: runtime.lastApplied.userSteering,
        finalMotor: runtime.lastApplied.finalMotor,
        finalSteering: runtime.lastApplied.finalSteering,
        actualMotor: focus.actualMotor,
        actualSteering: focus.actualSteering,
        steerOverridden: runtime.lastApplied.steerOverridden,
        motorOverridden: runtime.lastApplied.motorOverridden,
        invalidFields: runtime.lastApplied.invalidFields,
        collisions: this.collisions,
        debug: runtime.lastUserOutput.debug,
      },
      settings,
    };
  }

  /** Road-frame pose of every vehicle, keyed by id. */
  getVehicleFrames(): Map<string, VehicleFrame> {
    return new Map(
      this.vehicles.map((vehicle) => [
        vehicle.id,
        { s: vehicle.s, lateral: vehicle.lateral, headingOffset: vehicle.headingOffset },
      ]),
    );
  }

  /** Progress and collision counts for each player, in grid order. */
  getPlayerStates(): PlayerRaceState[] {
    return this.players.map(({ id }) => {
      const vehicle = this.playerVehicle(id);
      const runtime = this.playerRuntime(id);
      return {
        id,
        distance: vehicle.s - runtime.startS,
        s: vehicle.s,
        speed: vehicle.speed,
        laneIndex: vehicle.laneIndex,
        collisions: runtime.collisions,
        atFaultCollisions: runtime.atFaultCollisions,
        edgeHits: runtime.edgeHits,
        stalled: runtime.stallUntil > this.time,
      };
    });
  }

  get currentTime(): number {
    return this.time;
  }

  /**
   * The nearest vehicle ahead whose body comes within `lateralMargin` meters of overlapping the
   * player's: true bumper-to-bumper gap and its speed.
   */
  playerLeadAhead(id: string, lateralMargin = 0): { gap: number; speed: number } | undefined {
    const ego = this.playerVehicle(id);
    let lead: { gap: number; speed: number } | undefined;
    for (const other of this.vehicles) {
      if (other === ego || other.s <= ego.s) continue;
      if (Math.abs(other.lateral - ego.lateral) > (other.width + ego.width) / 2 + lateralMargin) continue;
      const gap = other.s - ego.s - (other.length + ego.length) / 2;
      if (!lead || gap < lead.gap) lead = { gap, speed: other.speed };
    }
    return lead;
  }

  private getLeadVehicleTelemetry(input: AutopilotInput) {
    const lead = closestVehicleAhead(input.vehicles, input.laneLines);
    if (!lead) return undefined;
    return {
      id: lead.id,
      speedMph: metersPerSecondToMph(input.ego.speed + lead.relativeVy),
      relativeX: lead.relativeX,
      relativeY: lead.relativeY,
      relativeVx: lead.relativeVx,
      relativeVy: lead.relativeVy,
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
        edgeContact: vehicle.edgeContact ?? false,
        personality: vehicle.personality?.label,
        laneDrifter: vehicle.personality?.laneDrifter ?? false,
      })),
    };
  }

  private get primaryId(): string {
    return this.players[0].id;
  }

  private playerVehicle(id: string): VehicleState {
    const vehicle = this.vehicles.find((candidate) => candidate.id === id && candidate.kind === 'ego');
    if (!vehicle) throw new Error(`Player vehicle ${id} is missing from the simulation.`);
    return vehicle;
  }

  private playerRuntime(id: string): PlayerRuntime {
    const runtime = this.playerRuntimes.get(id);
    if (!runtime) throw new Error(`Player ${id} is not part of the simulation.`);
    return runtime;
  }

  private playerStations(): number[] {
    return this.vehicles.filter((vehicle) => vehicle.kind === 'ego').map((vehicle) => vehicle.s);
  }

  private minPlayerS(): number {
    return Math.min(...this.playerStations());
  }

  private maxPlayerS(): number {
    return Math.max(...this.playerStations());
  }

  private distanceToNearestPlayer(station: number): number {
    return Math.min(...this.playerStations().map((playerS) => Math.abs(station - playerS)));
  }

  private nearAnyPlayer(station: number, distance: number): boolean {
    return this.playerStations().some((playerS) => Math.abs(station - playerS) < distance);
  }

  /** Traffic count scales with how far the players have spread so density stays comparable. */
  private trafficWindowScale(): number {
    const window = this.maxPlayerS() - this.minPlayerS() + this.trafficBehind + this.trafficAhead;
    return window / (TRAFFIC_BACK_BUFFER + TRAFFIC_FRONT_BUFFER);
  }

  private seedTraffic(settings: PlaygroundSettings): void {
    const count = this.targetTrafficCount(settings);
    const spacing = this.trafficSpacing(settings);
    let index = 0;

    for (let lane = 0; lane < this.road.laneCount && index < count; lane += 1) {
      let station = this.minPlayerS() - this.trafficBehind + this.rng.range(0, spacing);
      while (station < this.maxPlayerS() + this.trafficAhead && index < count) {
        if (!this.nearAnyPlayer(station, 26)) {
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
        .sort((a, b) => this.distanceToNearestPlayer(b.s) - this.distanceToNearestPlayer(a.s))
        .slice(0, currentCount - targetCount)
        .map((vehicle) => vehicle.id);
      this.vehicles = this.vehicles.filter((vehicle) => !removable.includes(vehicle.id));
    }
  }

  private recycleTraffic(settings: PlaygroundSettings): void {
    for (const vehicle of this.vehicles) {
      if (vehicle.kind !== 'traffic') continue;
      const minS = this.minPlayerS();
      if (vehicle.s < minS - this.trafficBehind || vehicle.s > this.maxPlayerS() + this.trafficAhead) {
        const lane = this.rng.int(0, this.road.laneCount - 1);
        vehicle.s = this.findOpenSpawnStation(lane, settings, vehicle.s < minS);
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
        this.collisionVisualUntil.delete(vehicle.id);
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

  /** Sideways offset from lane center a traffic driver is wandering toward, positive = right. */
  private trafficWeaveOffset(vehicle: VehicleState, dt: number): number {
    const personality = vehicle.personality;
    if (!personality || personality.weaveAmplitude <= 0) return 0;

    const holdingLane = vehicle.targetLane === vehicle.laneIndex;
    const blend = vehicle.weaveBlend ?? 0;
    vehicle.weaveBlend = holdingLane
      ? Math.min(1, blend + WEAVE_FADE_IN_RATE * dt)
      : Math.max(0, blend - WEAVE_FADE_OUT_RATE * dt);
    if (vehicle.weaveBlend === 0) return 0;

    const drifter = personality.laneDrifter;
    const period = personality.weavePeriod * (drifter ? LANE_DRIFT_PERIOD_SCALE : 1);
    // Two incommensurate sines so the wander doesn't look like a metronome. Their weights sum to 1.
    const phase = (this.time / period) * Math.PI * 2 + personality.weavePhase;
    const wander = 0.7 * Math.sin(phase) + 0.3 * Math.sin(phase * 2.17 + personality.weavePhase * 1.3);
    const offset = (drifter ? LANE_DRIFT_AMPLITUDE : personality.weaveAmplitude) * wander;

    const laneRoom = this.road.laneWidth / 2 - vehicle.width / 2;
    const side = offset < 0 ? -1 : 1;
    const neighborLane = vehicle.targetLane + side;
    const maxOffset =
      neighborLane < 0 || neighborLane >= this.road.laneCount
        ? laneRoom - WEAVE_EDGE_MARGIN
        : drifter && this.isDriftClear(vehicle, neighborLane)
          ? laneRoom + LANE_DRIFT_OVER_LINE
          : laneRoom - WEAVE_LANE_MARGIN;
    return side * Math.min(Math.abs(offset), Math.max(0, maxOffset)) * vehicle.weaveBlend;
  }

  /** True when no other vehicle is in or entering `lane` near `vehicle`. */
  private isDriftClear(vehicle: VehicleState, lane: number): boolean {
    const laneCenter = this.road.getLaneCenterOffset(lane);
    for (const other of this.vehicles) {
      // Skip vehicles whose body can't reach the strip of the lane the drifter would cross into.
      if (other === vehicle || Math.abs(other.lateral - laneCenter) > this.road.laneWidth * 0.75) continue;
      const clearDistance = LANE_DRIFT_CLEAR_DISTANCE + Math.abs(other.speed - vehicle.speed) * LANE_DRIFT_CLEAR_SECONDS;
      if (Math.abs(other.s - vehicle.s) < clearDistance) return false;
    }
    return true;
  }

  private trackEdgeHit(runtime: PlayerRuntime, vehicle: VehicleState): void {
    if (vehicle.edgeContact) {
      if (runtime.edgeHitArmed) runtime.edgeHits += 1;
      runtime.edgeHitArmed = false;
    } else if (roadEdgeLimit(vehicle, this.road) - Math.abs(vehicle.lateral) >= EDGE_HIT_REARM_DISTANCE) {
      runtime.edgeHitArmed = true;
    }
  }

  private resolveCloseVehicles(): void {
    this.collisionEvents = this.collisionEvents.filter(
      (event) => this.time - event.startedAt < event.duration,
    );
    for (const [pairKey, lastStartedAt] of this.collisionPairLastStarted) {
      if (this.time - lastStartedAt > COLLISION_FEEDBACK_DURATION * 2) {
        this.collisionPairLastStarted.delete(pairKey);
      }
    }
    for (const [vehicleId, visualUntil] of this.collisionVisualUntil) {
      if (visualUntil <= this.time) this.collisionVisualUntil.delete(vehicleId);
    }
    for (const vehicle of this.vehicles) vehicle.collision = false;
    const collisionPairsThisStep = new Set<string>();
    const sortedVehicles = [...this.vehicles].sort((a, b) => a.s - b.s);
    let largestDiagonal = 0;
    for (const vehicle of sortedVehicles) largestDiagonal = Math.max(largestDiagonal, Math.hypot(vehicle.length, vehicle.width));

    for (let behindIndex = 0; behindIndex < sortedVehicles.length; behindIndex += 1) {
      const behind = sortedVehicles[behindIndex];
      const behindDiagonal = Math.hypot(behind.length, behind.width);
      // No vehicle farther ahead than this can reach `behind`, whatever its size.
      const searchLimit = (behindDiagonal + largestDiagonal) / 2 + 3.5;
      for (let aheadIndex = behindIndex + 1; aheadIndex < sortedVehicles.length; aheadIndex += 1) {
        const ahead = sortedVehicles[aheadIndex];
        const gap = ahead.s - behind.s;
        if (gap > searchLimit) break;
        // Half diagonals enclose rotated bodies; the extra distance allows for road curvature.
        // This bound depends on both vehicles, so a short car cannot end the search early;
        // `searchLimit` above covers the longest vehicle instead.
        const maxRelevantGap = (behindDiagonal + Math.hypot(ahead.length, ahead.width)) / 2 + 3.5;
        if (gap > maxRelevantGap) continue;

        const lateralGap = Math.abs(ahead.lateral - behind.lateral);
        const bodyHalfWidth = (behind.width + ahead.width) / 2;
        const bodyHalfLength = (behind.length + ahead.length) / 2;

        const pairKey = collisionPairKey(behind, ahead);
        const contact = this.vehicleContact(behind, ahead);
        if (contact) {
          behind.collision = true;
          ahead.collision = true;
          this.collisionVisualUntil.set(behind.id, this.time + COLLISION_CONTACT_VISUAL_HOLD);
          this.collisionVisualUntil.set(ahead.id, this.time + COLLISION_CONTACT_VISUAL_HOLD);
          collisionPairsThisStep.add(pairKey);
          const lastStartedAt = this.collisionPairLastStarted.get(pairKey) ?? Number.NEGATIVE_INFINITY;
          const closingSpeed = this.contactClosingSpeed(behind, ahead, contact);
          const isNewContact = !this.activeCollisionPairs.has(pairKey);
          const isRepeatedImpact = closingSpeed >= COLLISION_REPEAT_IMPACT_SPEED;
          if (
            (isNewContact || isRepeatedImpact) &&
            this.time - lastStartedAt >= COLLISION_EVENT_COOLDOWN
          ) {
            this.startCollisionEvent(behind, ahead, pairKey, contact, closingSpeed);
          }
          this.resolveVehicleContact(behind, ahead, contact);
          continue;
        }

        if (this.activeCollisionPairs.has(pairKey) && this.vehicleContact(behind, ahead, 0.3)) {
          collisionPairsThisStep.add(pairKey);
          this.collisionVisualUntil.set(behind.id, this.time + COLLISION_CONTACT_VISUAL_HOLD);
          this.collisionVisualUntil.set(ahead.id, this.time + COLLISION_CONTACT_VISUAL_HOLD);
        }

        const longitudinalClearance = gap - bodyHalfLength;
        const substantiallySameLane = lateralGap < bodyHalfWidth * 0.72;
        if (
          behind.kind === 'traffic' &&
          substantiallySameLane &&
          longitudinalClearance >= 0 &&
          longitudinalClearance < 1.05
        ) {
          const allowedClosingSpeed = longitudinalClearance * 1.8;
          behind.speed = Math.min(behind.speed, ahead.speed + allowedClosingSpeed);
        }
      }
    }

    this.activeCollisionPairs = collisionPairsThisStep;
  }

  private startCollisionEvent(
    a: VehicleState,
    b: VehicleState,
    pairKey: string,
    contact: CollisionContact,
    closingSpeed: number,
  ): void {
    const pointA = this.road.worldPointAt(a.s, a.lateral);
    const pointB = this.road.worldPointAt(b.s, b.lateral);
    const forwardA = a.speed * Math.cos(a.headingOffset);
    const lateralA = a.speed * Math.sin(a.headingOffset);
    const forwardB = b.speed * Math.cos(b.headingOffset);
    const lateralB = b.speed * Math.sin(b.headingOffset);
    const relativeSpeed = Math.hypot(forwardA - forwardB, lateralA - lateralB);
    const severity = clamp(Math.max(closingSpeed, relativeSpeed * 0.35) / 14, 0.2, 1);

    const faultVehicleId = this.collisionFault(a, b, contact);
    this.collisionSequence += 1;
    this.collisionEvents.push({
      id: `collision-${this.collisionSequence}`,
      vehicleIds: [a.id, b.id],
      point: {
        x: (pointA.x + pointB.x) / 2,
        y: (pointA.y + pointB.y) / 2,
      },
      kind: this.classifyCollision(a, b, contact),
      egoInvolved: a.kind === 'ego' || b.kind === 'ego',
      faultVehicleId,
      severity,
      startedAt: this.time,
      duration: COLLISION_FEEDBACK_DURATION + severity * 0.2,
    });
    if (a.kind === 'ego' || b.kind === 'ego') this.collisions += 1;
    for (const vehicle of [a, b]) {
      const runtime = this.playerRuntimes.get(vehicle.id);
      if (!runtime || vehicle.kind !== 'ego') continue;
      runtime.collisions += 1;
      if (faultVehicleId === vehicle.id) {
        runtime.atFaultCollisions += 1;
        runtime.stallUntil = Math.max(runtime.stallUntil, this.time + this.atFaultStallSeconds);
      }
    }
    this.collisionPairLastStarted.set(pairKey, this.time);
  }

  /**
   * Picks the vehicle that caused a contact, or undefined when blame is shared.
   * `behind` is the vehicle with the smaller road station.
   */
  private collisionFault(behind: VehicleState, ahead: VehicleState, contact: CollisionContact): string | undefined {
    const kind = this.classifyCollision(behind, ahead, contact);
    const behindEncroach = lateralSpeedToward(behind, ahead);
    const aheadEncroach = lateralSpeedToward(ahead, behind);

    if (kind === 'rear-end') {
      // A sharp cut-in makes the merging vehicle responsible; otherwise the follower is.
      const cutIn = aheadEncroach > CUT_IN_LATERAL_SPEED_THRESHOLD && aheadEncroach > behindEncroach;
      return cutIn ? ahead.id : behind.id;
    }

    if (Math.max(behindEncroach, aheadEncroach) > FAULT_LATERAL_SPEED_THRESHOLD) {
      return behindEncroach > aheadEncroach ? behind.id : ahead.id;
    }

    // Neither is moving sideways: blame whoever has drifted farther from their lane toward the other.
    const behindDrift = this.laneDriftToward(behind, ahead);
    const aheadDrift = this.laneDriftToward(ahead, behind);
    if (Math.abs(behindDrift - aheadDrift) < 0.15) return undefined;
    return behindDrift > aheadDrift ? behind.id : ahead.id;
  }

  private laneDriftToward(vehicle: VehicleState, other: VehicleState): number {
    const direction = Math.sign(other.lateral - vehicle.lateral) || 1;
    // Traffic declares the lane it is heading for; players are judged from the lane they last settled in.
    const lane = vehicle.kind === 'ego' ? vehicle.settledLane ?? vehicle.laneIndex : vehicle.targetLane;
    const laneCenter = this.road.getLaneCenterOffset(lane);
    return (vehicle.lateral - laneCenter) * direction;
  }

  /** The vehicle's current lane once it is centered and aligned in it, otherwise its previous settled lane. */
  private settledLaneOf(vehicle: VehicleState): number {
    const centered = Math.abs(vehicle.lateral - this.road.getLaneCenterOffset(vehicle.laneIndex)) < SETTLED_LANE_OFFSET;
    const aligned = Math.abs(vehicle.headingOffset) < SETTLED_LANE_HEADING;
    return centered && aligned ? vehicle.laneIndex : vehicle.settledLane ?? vehicle.laneIndex;
  }

  private vehicleContact(a: VehicleState, b: VehicleState, margin = 0): CollisionContact | undefined {
    const rectA = this.vehicleCollisionRect(a);
    const rectB = this.vehicleCollisionRect(b);
    const radius = Math.hypot(rectA.halfLength, rectA.halfWidth) +
      Math.hypot(rectB.halfLength, rectB.halfWidth) + margin * 2;
    if ((rectA.center.x - rectB.center.x) ** 2 + (rectA.center.y - rectB.center.y) ** 2 > radius ** 2) {
      return undefined;
    }
    const axes = [rectA.forward, rectA.right, rectB.forward, rectB.right];
    let minimumPenetration = Number.POSITIVE_INFINITY;
    let minimumAxis = axes[0];

    for (const axis of axes) {
      const projectionA = projectCollisionRect(rectA, axis);
      const projectionB = projectCollisionRect(rectB, axis);
      // Distance to the nearest separating edge also handles containment correctly.
      const penetration = Math.min(
        projectionA.max - projectionB.min,
        projectionB.max - projectionA.min,
      );
      if (penetration <= -margin) return undefined;
      if (penetration < minimumPenetration) {
        minimumPenetration = penetration;
        minimumAxis = axis;
      }
    }

    const centerDelta = {
      x: rectB.center.x - rectA.center.x,
      y: rectB.center.y - rectA.center.y,
    };
    const direction = dot(centerDelta, minimumAxis) < 0 ? -1 : 1;
    return {
      normal: {
        x: minimumAxis.x * direction,
        y: minimumAxis.y * direction,
      },
      penetration: minimumPenetration,
    };
  }

  private resolveVehicleContact(a: VehicleState, b: VehicleState, contact: CollisionContact): void {
    const inverseMassA = 1 / approximateVehicleMass(a);
    const inverseMassB = 1 / approximateVehicleMass(b);
    const inverseMassTotal = inverseMassA + inverseMassB;
    const correction = clamp(
      contact.penetration + COLLISION_POSITION_SLOP,
      0,
      COLLISION_MAX_CORRECTION,
    );

    if (correction > 0) {
      const shareA = inverseMassA / inverseMassTotal;
      const shareB = inverseMassB / inverseMassTotal;
      this.moveVehicleInWorld(
        a,
        -contact.normal.x * correction * shareA,
        -contact.normal.y * correction * shareA,
      );
      this.moveVehicleInWorld(
        b,
        contact.normal.x * correction * shareB,
        contact.normal.y * correction * shareB,
      );
    }

    const velocityA = this.vehicleWorldVelocity(a);
    const velocityB = this.vehicleWorldVelocity(b);
    const closingSpeed = this.contactClosingSpeedFromVelocities(velocityA, velocityB, contact);
    if (closingSpeed <= 0) return;

    const impulse = closingSpeed / inverseMassTotal;
    this.setVehicleWorldVelocity(a, {
      x: velocityA.x - contact.normal.x * impulse * inverseMassA,
      y: velocityA.y - contact.normal.y * impulse * inverseMassA,
    });
    this.setVehicleWorldVelocity(b, {
      x: velocityB.x + contact.normal.x * impulse * inverseMassB,
      y: velocityB.y + contact.normal.y * impulse * inverseMassB,
    });
  }

  private contactClosingSpeed(a: VehicleState, b: VehicleState, contact: CollisionContact): number {
    return this.contactClosingSpeedFromVelocities(
      this.vehicleWorldVelocity(a),
      this.vehicleWorldVelocity(b),
      contact,
    );
  }

  private contactClosingSpeedFromVelocities(
    velocityA: CollisionAxis,
    velocityB: CollisionAxis,
    contact: CollisionContact,
  ): number {
    return Math.max(
      0,
      dot(
        { x: velocityA.x - velocityB.x, y: velocityA.y - velocityB.y },
        contact.normal,
      ),
    );
  }

  private moveVehicleInWorld(vehicle: VehicleState, dx: number, dy: number): void {
    const roadSample = this.road.sampleAt(vehicle.s);
    const forward = { x: Math.sin(roadSample.heading), y: Math.cos(roadSample.heading) };
    const right = { x: Math.cos(roadSample.heading), y: -Math.sin(roadSample.heading) };
    vehicle.s = Math.max(0, vehicle.s + dx * forward.x + dy * forward.y);
    const lateralDelta = dx * right.x + dy * right.y;
    const roadLimit = Math.max(0.1, this.road.getRoadHalfWidth() - vehicle.width / 2 - 0.03);
    vehicle.lateral = clamp(vehicle.lateral + lateralDelta, -roadLimit, roadLimit);
    vehicle.laneIndex = this.road.getLaneIndex(vehicle.lateral);
  }

  private vehicleWorldVelocity(vehicle: VehicleState): CollisionAxis {
    const roadHeading = this.road.sampleAt(vehicle.s).heading;
    const heading = roadHeading + vehicle.headingOffset;
    return {
      x: Math.sin(heading) * vehicle.speed,
      y: Math.cos(heading) * vehicle.speed,
    };
  }

  private setVehicleWorldVelocity(vehicle: VehicleState, velocity: CollisionAxis): void {
    const roadHeading = this.road.sampleAt(vehicle.s).heading;
    const roadForward = { x: Math.sin(roadHeading), y: Math.cos(roadHeading) };
    const roadRight = { x: Math.cos(roadHeading), y: -Math.sin(roadHeading) };
    const forwardSpeed = Math.max(0, dot(velocity, roadForward));
    const lateralSpeed = dot(velocity, roadRight);
    vehicle.speed = Math.hypot(forwardSpeed, lateralSpeed);
    vehicle.headingOffset = clamp(
      Math.atan2(lateralSpeed, Math.max(0.01, forwardSpeed)),
      -0.95,
      0.95,
    );
  }

  private classifyCollision(a: VehicleState, b: VehicleState, contact: CollisionContact): CollisionKind {
    const roadHeading = this.road.sampleAt((a.s + b.s) / 2).heading;
    const roadForward = { x: Math.sin(roadHeading), y: Math.cos(roadHeading) };
    const roadRight = { x: Math.cos(roadHeading), y: -Math.sin(roadHeading) };
    const forwardAlignment = Math.abs(dot(contact.normal, roadForward));
    const lateralAlignment = Math.abs(dot(contact.normal, roadRight));

    if (lateralAlignment > forwardAlignment * 1.35) return 'sideswipe';
    if (forwardAlignment > lateralAlignment * 1.35) return 'rear-end';
    return 'corner';
  }

  private vehicleCollisionRect(vehicle: VehicleState): CollisionRect {
    const pose = this.road.worldPointAt(vehicle.s, vehicle.lateral);
    const heading = pose.heading + vehicle.headingOffset;
    return {
      center: { x: pose.x, y: pose.y },
      forward: { x: Math.sin(heading), y: Math.cos(heading) },
      right: { x: Math.cos(heading), y: -Math.sin(heading) },
      halfLength: vehicle.length / 2,
      halfWidth: vehicle.width / 2,
    };
  }

  private targetTrafficCount(settings: PlaygroundSettings): number {
    const density = clamp(settings.trafficDensity, 0, 1);
    const count = TRAFFIC_MIN_COUNT + density ** 1.28 * (TRAFFIC_MAX_COUNT - TRAFFIC_MIN_COUNT);
    return Math.round(Math.min(TRAFFIC_MAX_SCALED_COUNT, count * this.trafficWindowScale()));
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
    const firstPlayerS = this.minPlayerS();
    const lastPlayerS = this.maxPlayerS();
    const minS = firstPlayerS - this.trafficBehind;
    const maxS = lastPlayerS + this.trafficAhead;
    const minGap = Math.max(TRAFFIC_MIN_SPAWN_GAP, this.trafficSpacing(settings) * 0.62);
    const laneVehicles = this.vehicles
      .filter((vehicle) => vehicle.kind === 'traffic' && vehicle.laneIndex === lane)
      .map((vehicle) => vehicle.s)
      .sort((a, b) => a - b);

    const randomMin = preferAhead ? lastPlayerS + 170 : minS;
    const randomMax = preferAhead ? maxS : firstPlayerS - 80;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = this.rng.range(randomMin, randomMax);
      if (this.nearAnyPlayer(candidate, 28)) continue;
      if (laneVehicles.every((station) => Math.abs(station - candidate) >= minGap)) return candidate;
    }

    const bounds = [minS, ...laneVehicles.filter((station) => station >= minS && station <= maxS), maxS];
    let bestStation = preferAhead ? lastPlayerS + 180 : firstPlayerS - 120;
    let bestGap = 0;
    for (let index = 1; index < bounds.length; index += 1) {
      const gap = bounds[index] - bounds[index - 1];
      const midpoint = (bounds[index] + bounds[index - 1]) / 2;
      if (gap > bestGap && !this.nearAnyPlayer(midpoint, 28)) {
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

function dot(a: CollisionAxis, b: CollisionAxis): number {
  return a.x * b.x + a.y * b.y;
}

function approximateVehicleMass(vehicle: VehicleState): number {
  return Math.max(900, vehicle.length * vehicle.width * 180);
}

function lateralSpeedToward(vehicle: VehicleState, other: VehicleState): number {
  const direction = Math.sign(other.lateral - vehicle.lateral) || 1;
  return vehicle.speed * Math.sin(vehicle.headingOffset) * direction;
}

function idleAppliedControls(): AppliedControls {
  return {
    userMotor: 0,
    userSteering: 0,
    finalMotor: 0,
    finalSteering: 0,
    actualMotor: 0,
    actualSteering: 0,
    steerOverridden: false,
    motorOverridden: false,
    invalidFields: [],
  };
}

function collisionPairKey(a: VehicleState, b: VehicleState): string {
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}
