import { useLayoutEffect, useRef } from 'react';
import { RACE_SCORING } from '../multiplayer/scoring';
import { CartoonRenderer, raceCameraTarget, type CartoonPlayerLabel } from '../rendering';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP, Simulation, interpolateVehicleFrames } from '../simulation';
import type { PlaygroundSettings } from '../types';

const DRIVERS = [
  { id: 'ada', name: 'Ada', color: '#ff5a5f' },
  { id: 'grace', name: 'Grace', color: '#3d8bff' },
  { id: 'linus', name: 'Linus', color: '#ffb400' },
  { id: 'katherine', name: 'Katherine', color: '#b15cff' },
  { id: 'alan', name: 'Alan', color: '#00c2a8' },
];

const MAX_STEPS_PER_FRAME = 6;

/**
 * A race drawn like the presenter screen, driven by the built-in assists
 * ("Steer for me" and "Accelerate for me") instead of player code.
 */
export function DemoRace({ className, seed = 7, scale = 9 }: { className?: string; seed?: number; scale?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const settings: PlaygroundSettings = {
      ...DEFAULT_SETTINGS,
      seed,
      trafficDensity: 0.4,
      startingSpeed: 22,
      steerAssist: true,
      accelerateAssist: true,
      debugOverlays: false,
    };
    const simulation = new Simulation(settings, { players: DRIVERS.map(({ id, color }) => ({ id, color })) });
    const renderer = new CartoonRenderer(canvas);
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(canvas);
    const camera = { centerS: 0, scale };
    let previous = performance.now();
    let pending = 0;
    let frame = 0;
    // The last two steps' poses. Each frame draws a blend between them, one step behind the simulation.
    let fromFrames = simulation.getVehicleFrames();
    let toFrames = fromFrames;

    const loop = (now: number) => {
      const elapsed = Math.min(0.25, Math.max(0, (now - previous) / 1000));
      previous = now;
      pending += elapsed;
      for (let steps = 0; pending >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_FRAME; steps += 1) {
        // The assists read each car's sensors, so refresh them every step.
        for (const { id } of DRIVERS) simulation.createPlayerInput(id, settings, FIXED_TIMESTEP);
        simulation.stepPlayers(FIXED_TIMESTEP, new Map(), settings);
        fromFrames = toFrames;
        toFrames = simulation.getVehicleFrames();
        pending -= FIXED_TIMESTEP;
      }
      pending = Math.min(pending, FIXED_TIMESTEP);
      const poses = interpolateVehicleFrames(fromFrames, toFrames, pending / FIXED_TIMESTEP);

      const states = simulation.getPlayerStates().map((state) => ({ ...state, s: poses.get(state.id)?.s ?? state.s }));
      const target = raceCameraTarget(
        states.map((state) => state.s),
        { viewportWidth: renderer.viewportWidth, minScale: scale * 0.6, maxScale: scale, packWindowMeters: 120 },
      )!;
      // Snap on the first frame instead of panning in from the start of the road.
      const blend = camera.centerS === 0 ? 1 : Math.min(1, elapsed * 2.5);
      camera.centerS += (target.centerS - camera.centerS) * blend;
      camera.scale += (target.scale - camera.scale) * blend;
      const half = renderer.viewportWidth / 2 / camera.scale + 30;
      const snapshot = simulation.getSnapshot(settings, { centerS: camera.centerS, behindMeters: half, aheadMeters: half, poses });
      const players = new Map<string, CartoonPlayerLabel>(
        [...states]
          .sort((a, b) => b.s - a.s)
          .map((state, index) => {
            const driver = DRIVERS.find(({ id }) => id === state.id)!;
            return [state.id, { name: driver.name, color: driver.color, place: index + 1, stalled: state.stalled }];
          }),
      );
      renderer.render({ snapshot, scale: camera.scale, players, atFaultPenalty: RACE_SCORING.atFaultPenalty, time: now / 1000 });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [seed, scale]);

  return <canvas ref={canvasRef} className={className ?? 'h-full w-full'} />;
}
