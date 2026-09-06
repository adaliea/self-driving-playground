import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP } from './defaults';
import { Simulation } from './simulation';
import type { VehicleState } from './vehicle';

interface SimulationInternals {
  vehicles: VehicleState[];
  time: number;
  resolveCloseVehicles(): void;
  vehicleContact(a: VehicleState, b: VehicleState): { normal: { x: number; y: number }; penetration: number } | undefined;
}

describe('collision feedback events', () => {
  it('latches an ego sideswipe long enough to render after contact ends', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();

    const traffic = collisionVehicle('traffic-test', 'traffic', ego!.s + 0.08, ego!.lateral + 1.72);
    ego!.speed = 32;
    internals.vehicles = [ego!, traffic];
    internals.resolveCloseVehicles();

    const impact = simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0];
    expect(impact).toMatchObject({
      vehicleIds: ['ego', 'traffic-test'],
      kind: 'sideswipe',
      egoInvolved: true,
      age: 0,
    });

    internals.time = 0.5;
    internals.resolveCloseVehicles();
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0].age).toBeCloseTo(0.5);

    internals.time = 1.5;
    internals.resolveCloseVehicles();
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents).toHaveLength(0);
  });

  it('keeps traffic-only impacts local and does not increment the ego count', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    ego!.s = 120;
    const first = collisionVehicle('traffic-a', 'traffic', 160, 0);
    const second = collisionVehicle('traffic-b', 'traffic', 163.9, 0);
    internals.vehicles = [ego!, first, second];
    internals.resolveCloseVehicles();

    const snapshot = simulation.getSnapshot(DEFAULT_SETTINGS);
    expect(snapshot.collisionEvents).toHaveLength(1);
    expect(snapshot.collisionEvents[0]).toMatchObject({
      kind: 'rear-end',
      egoInvolved: false,
    });
    expect(snapshot.telemetry.collisions).toBe(0);
  });

  it('holds the vehicle collision highlight across brief solver separation', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    const traffic = collisionVehicle('traffic-highlight', 'traffic', ego!.s + 4, ego!.lateral);
    ego!.speed = 30;
    traffic.speed = 18;
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();
    traffic.s += 10;
    internals.time = 0.1;
    internals.resolveCloseVehicles();
    expect(snapshotVehicle(simulation, 'ego').collision).toBe(true);

    internals.time = 0.25;
    internals.resolveCloseVehicles();
    expect(snapshotVehicle(simulation, 'ego').collision).toBe(false);
  });

  it('registers contact when the rendered vehicle bodies first overlap', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    ego!.s = 120;
    ego!.lateral = 0;
    const traffic = collisionVehicle('traffic-visible-contact', 'traffic', 124.64, 0);
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();

    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.collisions).toBe(1);
    expect(snapshotVehicle(simulation, 'ego').collision).toBe(true);
  });
});

describe('axis-aware collision response', () => {
  it('detects a rotated corner beyond the unrotated width envelope', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = collisionVehicle('ego', 'ego', 120, 0);
    ego.headingOffset = 0.7;
    const traffic = collisionVehicle('corner', 'traffic', 121.2, 2.8);
    internals.vehicles = [ego, traffic];
    expect(internals.vehicleContact(ego, traffic)).toBeDefined();

    internals.resolveCloseVehicles();

    expect(simulation.getDebugState().collisions).toBe(1);
    expect(ego.collision).toBe(true);
  });

  it('computes enough separation when one projected box contains the other', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = collisionVehicle('ego', 'ego', 120, 0);
    const traffic = collisionVehicle('wide-truck', 'traffic', 120, 0);
    traffic.width = 2.55;
    traffic.length = 8.8;

    const contact = internals.vehicleContact(ego, traffic);
    expect(contact?.penetration).toBeCloseTo((ego.width + traffic.width) / 2, 6);
  });

  it('separates a sideswipe laterally without throwing ego backward', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();

    const traffic = collisionVehicle('traffic-side', 'traffic', ego!.s + 0.06, ego!.lateral + 1.55);
    ego!.speed = 34;
    ego!.headingOffset = 0.22;
    traffic.speed = 20;
    const egoStationBefore = ego!.s;
    const trafficStationBefore = traffic.s;
    const lateralGapBefore = traffic.lateral - ego!.lateral;
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();

    expect(traffic.lateral - ego!.lateral).toBeGreaterThan(lateralGapBefore);
    expect(Math.abs(ego!.s - egoStationBefore)).toBeLessThan(0.12);
    expect(Math.abs(traffic.s - trafficStationBefore)).toBeLessThan(0.12);
    expect(ego!.speed * Math.sin(ego!.headingOffset) - traffic.speed * Math.sin(traffic.headingOffset))
      .toBeLessThan(0.15);
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0].kind).toBe('sideswipe');
  });

  it('shares rear-impact correction and removes closing velocity', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();

    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 40;
    const traffic = collisionVehicle('traffic-ahead', 'traffic', 123.9, 0);
    traffic.speed = 15;
    const egoStationBefore = ego!.s;
    const trafficStationBefore = traffic.s;
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();

    expect(ego!.s).toBeLessThan(egoStationBefore);
    expect(traffic.s).toBeGreaterThan(trafficStationBefore);
    expect(egoStationBefore - ego!.s).toBeLessThan(0.4);
    expect(Math.abs(ego!.lateral)).toBeLessThan(0.003);
    expect(Math.abs(traffic.lateral)).toBeLessThan(0.003);
    expect(ego!.speed - traffic.speed).toBeLessThan(0.15);
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0].kind).toBe('rear-end');
  });

  it('does not snap a near sideswipe into a following position', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();

    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 24;
    const traffic = collisionVehicle('traffic-near-side', 'traffic', 124.7, 1.7);
    traffic.speed = 20;
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();

    expect(ego!.s).toBe(120);
    expect(traffic.s).toBe(124.7);
    expect(ego!.speed).toBe(24);
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents).toHaveLength(0);
  });

  it('does not apply the traffic following clamp to an approaching ego', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 30;
    const traffic = collisionVehicle('traffic-close-ahead', 'traffic', 125.2, 0);
    traffic.speed = 10;
    internals.vehicles = [ego!, traffic];

    internals.resolveCloseVehicles();

    expect(ego!.speed).toBe(30);
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.collisions).toBe(0);
  });

  it('counts repeated impacts while a max-throttle ego presses into traffic', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();

    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 38;
    const traffic = collisionVehicle('traffic-blocker', 'traffic', 124, 0);
    traffic.speed = 18;
    internals.vehicles = [ego!, traffic];
    let contactSteps = 0;

    for (let step = 0; step < 180; step += 1) {
      internals.time = step / 45;
      ego!.speed += 0.1;
      ego!.s += ego!.speed / 45;
      traffic.s += traffic.speed / 45;
      const stationBeforeResolution = ego!.s;
      internals.resolveCloseVehicles();
      expect(ego!.s).toBeGreaterThan(stationBeforeResolution - 0.35);
      if (ego!.collision) {
        contactSteps += 1;
        expect(ego!.speed - traffic.speed).toBeLessThan(0.15);
      }
    }

    expect(contactSteps).toBeGreaterThan(20);
    const collisionCount = simulation.getSnapshot(DEFAULT_SETTINGS).telemetry.collisions;
    expect(collisionCount).toBeGreaterThan(3);
    expect(collisionCount).toBeLessThan(8);
  });

  it('repeats feedback with full motor and steering assist enabled', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      trafficDensity: 0,
      noisyLaneLines: false,
      noisyVehicles: false,
      actuatorVariation: false,
      steerAssist: true,
    };
    const simulation = new Simulation(settings);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 34;
    const traffic = collisionVehicle('traffic-assisted-blocker', 'traffic', 124, 0);
    traffic.speed = 16;
    traffic.desiredSpeed = 16;
    traffic.laneChangeCooldown = 100;
    internals.vehicles = [ego!, traffic];

    for (let step = 0; step < 225; step += 1) {
      const input = simulation.createEgoInput(settings, FIXED_TIMESTEP);
      simulation.step(
        FIXED_TIMESTEP,
        { motor: 1, steering: 0, targetLane: input.targetLane },
        settings,
      );
    }

    const snapshot = simulation.getSnapshot(settings);
    expect(snapshot.telemetry.finalMotor).toBe(1);
    expect(snapshot.telemetry.steerOverridden).toBe(true);
    expect(snapshot.telemetry.collisions).toBeGreaterThan(1);
  });

  it('does not silently brake ego before its first assisted-steering impact', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      trafficDensity: 0,
      noisyLaneLines: false,
      noisyVehicles: false,
      actuatorVariation: false,
      steerAssist: true,
    };
    const simulation = new Simulation(settings);
    const internals = simulation as unknown as SimulationInternals;
    const ego = internals.vehicles.find((vehicle) => vehicle.kind === 'ego');
    expect(ego).toBeDefined();
    ego!.s = 120;
    ego!.lateral = 0;
    ego!.speed = 34;
    const traffic = collisionVehicle('traffic-first-impact', 'traffic', 135, 0);
    traffic.speed = 16;
    traffic.desiredSpeed = 16;
    traffic.laneChangeCooldown = 100;
    internals.vehicles = [ego!, traffic];
    let firstCollisionTime: number | undefined;

    for (let step = 0; step < 90; step += 1) {
      const input = simulation.createEgoInput(settings, FIXED_TIMESTEP);
      simulation.step(
        FIXED_TIMESTEP,
        { motor: 1, steering: 0, targetLane: input.targetLane },
        settings,
      );
      if (simulation.getDebugState().collisions > 0) {
        firstCollisionTime = simulation.getDebugState().time;
        break;
      }
    }

    expect(firstCollisionTime).toBeDefined();
    expect(firstCollisionTime!).toBeLessThan(1.2);
    expect(
      simulation
        .getSnapshot(settings)
        .collisionEvents.some((event) => event.vehicleIds.includes('traffic-first-impact')),
    ).toBe(true);
  });
});

function snapshotVehicle(simulation: Simulation, id: string) {
  const vehicle = simulation.getSnapshot(DEFAULT_SETTINGS).vehicles.find((candidate) => candidate.id === id);
  expect(vehicle).toBeDefined();
  return vehicle!;
}

function collisionVehicle(
  id: string,
  kind: VehicleState['kind'],
  s: number,
  lateral: number,
): VehicleState {
  return {
    id,
    kind,
    s,
    lateral,
    headingOffset: 0,
    speed: 20,
    laneIndex: 1,
    targetLane: 1,
    desiredSpeed: 20,
    width: 2.05,
    length: 4.65,
    color: '#ffffff',
    actualMotor: 0,
    actualSteering: 0,
    commandMotor: 0,
    commandSteering: 0,
    laneChangeCooldown: 0,
    collision: false,
  };
}
