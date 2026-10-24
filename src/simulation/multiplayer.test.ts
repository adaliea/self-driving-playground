import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP } from './defaults';
import { ROAD_LANE_COUNT, ROAD_LANE_WIDTH } from './road';
import { Simulation } from './simulation';
import type { VehicleState } from './vehicle';

interface SimulationInternals {
  vehicles: VehicleState[];
  time: number;
  resolveCloseVehicles(): void;
}

const players = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, color: '#ff00ff' }));

describe('multi-player simulation', () => {
  it('places players on a grid without traffic close by', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS, { players });
    const states = simulation.getPlayerStates();
    expect(states.map((state) => state.id)).toEqual(players.map((player) => player.id));
    expect(new Set(states.slice(0, 3).map((state) => state.laneIndex)).size).toBe(3);
    expect(states[0].s).toBeGreaterThan(states[3].s);
    expect(states.every((state) => state.distance === 0)).toBe(true);

    const vehicles = (simulation as unknown as SimulationInternals).vehicles;
    for (const traffic of vehicles.filter((vehicle) => vehicle.kind === 'traffic')) {
      for (const state of states) expect(Math.abs(traffic.s - state.s)).toBeGreaterThan(20);
    }
  });

  it('steps every player from its own output and tracks distance', () => {
    const settings = { ...DEFAULT_SETTINGS, trafficDensity: 0 };
    const simulation = new Simulation(settings, { players: players.slice(0, 2) });
    for (let step = 0; step < 90; step += 1) {
      for (const id of simulation.playerIds) simulation.createPlayerInput(id, settings, FIXED_TIMESTEP);
      simulation.stepPlayers(FIXED_TIMESTEP, new Map([['p1', { motor: 1, steering: 0 }]]), settings);
    }
    const [accelerating, coasting] = simulation.getPlayerStates();
    expect(accelerating.distance).toBeGreaterThan(coasting.distance);
    expect(simulation.getSnapshot(settings, { focusId: 'p2' }).telemetry.speed).toBeCloseTo(coasting.speed);
  });

  it('removes a retired player from the road and freezes its distance', () => {
    const settings = { ...DEFAULT_SETTINGS, trafficDensity: 0 };
    const simulation = new Simulation(settings, { players: players.slice(0, 2) });
    const drive = (steps: number) => {
      for (let step = 0; step < steps; step += 1) {
        for (const id of simulation.playerIds) simulation.createPlayerInput(id, settings, FIXED_TIMESTEP);
        simulation.stepPlayers(FIXED_TIMESTEP, new Map([['p1', { motor: 1, steering: 0 }], ['p2', { motor: 1, steering: 0 }]]), settings);
      }
    };
    drive(30);
    simulation.retirePlayer('p2');
    const retiredDistance = simulation.getPlayerStates()[1].distance;
    drive(30);

    const [racing, retired] = simulation.getPlayerStates();
    expect(retired).toMatchObject({ retired: true, distance: retiredDistance });
    expect(racing.retired).toBe(false);
    expect(simulation.getSnapshot(settings).vehicles.some((vehicle) => vehicle.id === 'p2')).toBe(false);
    expect(simulation.getVehicleFrames().has('p2')).toBe(false);
  });

  it('blames the follower for a rear-end and stalls it', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 2), atFaultStallSeconds: 2 });
    const internals = simulation as unknown as SimulationInternals;
    const [front, back] = internals.vehicles.filter((vehicle) => vehicle.kind === 'ego');
    front.s = 200;
    front.lateral = 0;
    front.speed = 15;
    back.s = 196;
    back.lateral = 0;
    back.speed = 30;
    internals.vehicles = [front, back];
    internals.resolveCloseVehicles();

    const event = simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0];
    expect(event).toMatchObject({ kind: 'rear-end', faultVehicleId: back.id });
    const [frontState, backState] = simulation.getPlayerStates();
    expect(frontState).toMatchObject({ collisions: 1, atFaultCollisions: 0, stalled: false });
    expect(backState).toMatchObject({ collisions: 1, atFaultCollisions: 1, stalled: true });
  });

  it('counts one edge hit per touch of the road edge and re-arms after pulling away', () => {
    const settings = { ...DEFAULT_SETTINGS, trafficDensity: 0, steerAssist: false, accelerateAssist: false };
    const simulation = new Simulation(settings, { players: players.slice(0, 1) });
    const [car] = (simulation as unknown as SimulationInternals).vehicles.filter((vehicle) => vehicle.kind === 'ego');
    const drive = (steering: number, seconds: number) => {
      for (let step = 0; step < Math.round(seconds / FIXED_TIMESTEP); step += 1) {
        simulation.createPlayerInput('p1', settings, FIXED_TIMESTEP);
        simulation.stepPlayers(FIXED_TIMESTEP, new Map([['p1', { motor: 0.6, steering }]]), settings);
      }
    };

    drive(0, 1);
    expect(simulation.getPlayerStates()[0].edgeHits).toBe(0);

    // Steer hard into the edge and keep scraping along it: still a single hit.
    drive(1, 4);
    const edgeLimit = (ROAD_LANE_COUNT * ROAD_LANE_WIDTH) / 2 - car.width / 2 - 0.03;
    expect(Math.abs(car.lateral)).toBeGreaterThan(edgeLimit - 0.1);
    expect(simulation.getPlayerStates()[0].edgeHits).toBe(1);

    // Back in the middle of the road, clear of the edge, then hit the same edge again.
    car.lateral = 0;
    car.headingOffset = 0;
    drive(0, 0.2);
    expect(Math.abs(car.lateral)).toBeLessThan(edgeLimit - 0.3);
    drive(1, 4);
    expect(simulation.getPlayerStates()[0].edgeHits).toBe(2);
  });

  it('blames the vehicle moving sideways in a sideswipe', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 2) });
    const internals = simulation as unknown as SimulationInternals;
    const [steady, swerving] = internals.vehicles.filter((vehicle) => vehicle.kind === 'ego');
    steady.s = 200;
    steady.lateral = 0;
    steady.headingOffset = 0;
    swerving.s = 200.5;
    swerving.lateral = 1.9;
    swerving.speed = 25;
    swerving.headingOffset = -0.12;
    internals.vehicles = [steady, swerving];
    internals.resolveCloseVehicles();

    const event = simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0];
    expect(event).toMatchObject({ kind: 'sideswipe', faultVehicleId: swerving.id });
  });

  it('scales traffic with a smaller window so density stays the same', () => {
    const traffic = (simulation: Simulation) =>
      (simulation as unknown as SimulationInternals).vehicles.filter((vehicle) => vehicle.kind === 'traffic');
    const full = traffic(new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 1) }));
    const small = traffic(
      new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 1), trafficWindow: { behind: 120, ahead: 320 } }),
    );
    expect(small.length / full.length).toBeCloseTo(440 / 1070, 1);
    const [ego] = new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 1) }).getPlayerStates();
    for (const vehicle of small) {
      expect(vehicle.s).toBeGreaterThan(ego.s - 120);
      expect(vehicle.s).toBeLessThan(ego.s + 320);
    }
  });

  // The short vehicle sits past its own contact range, so ending the search there would miss the trailer.
  it('still finds a contact with a long vehicle beyond a short one', () => {
    const simulation = new Simulation(DEFAULT_SETTINGS, { players: players.slice(0, 2) });
    const internals = simulation as unknown as SimulationInternals;
    const [front, back] = internals.vehicles.filter((vehicle) => vehicle.kind === 'ego');
    const trailer = { ...front, id: 'trailer', kind: 'traffic' as const, length: 16, s: 206, lateral: 0, speed: 15 };
    const bike = { ...front, id: 'bike', kind: 'traffic' as const, length: 2, width: 0.8, s: 204.5, lateral: 3.7, speed: 15 };
    back.s = 196.5;
    back.lateral = 0;
    back.speed = 30;
    front.s = 1000;
    internals.vehicles = [back, bike, trailer, front];
    internals.resolveCloseVehicles();
    expect(simulation.getSnapshot(DEFAULT_SETTINGS).collisionEvents[0]).toMatchObject({ vehicleIds: [back.id, 'trailer'] });
  });
});
