# Self-Driving Playground

A web-based PID control playground for a top-down self-driving highway simulation. Users edit TypeScript autopilot code in a VS-Code-like editor and immediately see how the controller behaves with noisy sensors, traffic, assist overrides, and imperfect actuation.

## Run

```bash
npm install
npm run dev
```

Build check:

```bash
npm run build
```

Headless traffic/personality report:

```bash
npm run traffic:report -- --density 0.9 --runs 3 --seconds 90 --warmup 15 --start-speed 24
```

This runs built-in traffic outside the user-code runner and reports traffic wave strength, speed spread, physical clearance, lane-keeping quality, assigned-lane exits, road exits, flow, collision events, hard braking events, lane changes, and per-personality behavior. Use `--noisy-lanes`, `--noisy-vehicles`, `--actuator-variation`, or `--json` for alternate test modes.

## Project Structure

```text
src/
  simulation/  deterministic road generation, sensors, vehicle physics, traffic, controllers
  rendering/   direct Canvas 2D renderer; simulator objects are not rendered through React
  sandbox/     TypeScript transpilation and sandboxed iframe/worker client
  toolbox/     insertable helper snippets and built-in controller examples
  types/       documented public autopilot API types
  ui/          React/Tailwind controls, Monaco editor, telemetry, toolbox menus
public/
  sandbox.html isolated browser sandbox host
```

## Autopilot API

User code should export or define:

```ts
export function autopilot(input: AutopilotInput): AutopilotOutput {
  return {
    motor: 0,
    steering: 0,
    targetLane: input.targetLane,
  };
}
```

The editor exposes documented public types for `AutopilotInput`, `AutopilotOutput`, vehicle detections, and lane-line samples. The simulator clamps invalid `motor` and `steering` values to `[-1, 1]` and ignores untrusted fields for physics.

## Sandbox Model

The main React app does not execute user code directly. It transpiles TypeScript to CommonJS JavaScript, then sends it by `postMessage` to `public/sandbox.html`, which is mounted as a hidden iframe with restrictive sandbox attributes. The iframe creates a Blob Web Worker for user code and communicates only through validated structured messages.

The worker blocks common network and storage APIs where feasible, including `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `localStorage`, `sessionStorage`, `indexedDB`, and `caches`. Each autopilot call has a frame budget; if user code hangs, the iframe terminates and recreates the worker.

Current limitations:

- This browser sandbox is a defense-in-depth MVP, not a full security boundary against a determined attacker.
- Browser memory limits cannot be precisely enforced from JavaScript.
- Future leaderboard scoring must not trust client-reported results. The intended design is to submit code, seed, settings, and metadata, then replay and score deterministically in a controlled environment.

## Simulation Model

- Road generation is deterministic from a seed and uses smooth base curvature plus localized turn features sampled into a 3-lane highway.
- Vehicles use Frenet-like coordinates over the road centerline.
- Longitudinal dynamics include nonlinear acceleration, braking, and drag.
- Steering has actuator smoothing and road-curvature-relative heading dynamics.
- Traffic uses the same normalized controller output shape as ego controllers, with built-in lane centering, adaptive speed control, target-lane changes, varied driving personalities, and mixed lane-control models.
- Ego assist uses the same user-facing sensor inputs as user code, but runs stronger lateral-velocity lane keeping and adaptive cruise controllers.
- Sensors produce ego-relative bounding boxes and lane-line samples, with optional distance-scaled jitter, missing samples, degraded confidence, and smoothing delay. Lane-line sampling is denser near the ego vehicle.

Known simplifications:

- Tire dynamics, suspension, and exact collision geometry are intentionally simplified.
- Traffic decisions are local heuristics rather than full planning.
- Lane samples are generated from known road geometry with perception noise, not image processing.
- Ego lane-changing UI is not exposed yet, although `targetLane` exists in the API.

## Built-In Examples

The app includes:

- P-only lane keeping
- PID lane keeping
- PID lane keeping plus speed control
- Adaptive cruise
- Lane keeping with `Accelerate for me`
- Speed control with `Steer for me`
- Intentionally bad oscillating controller

The default example is a working PID lane-keeping controller with comments explaining the P, I, and D terms. Examples can attach `debug.lanePid` or `debug.speedPid` so the telemetry panel shows PID terms.

## Toolbox

The toolbox panel provides inspectable TypeScript helpers from a virtual `autopilot-toolbox.ts` file:

- `clamp`
- vehicle lane filtering and closest-vehicle-ahead
- stateful PID controller object
- lane-line interpretation
- acceleration feedforward
- adaptive cruise target-speed snippet

Each helper can insert a short usage example at the bottom of the editor. The implementations stay out of `Autopilot.ts`, but Monaco can still navigate to them with Go to Definition / Ctrl-click, opening the read-only toolbox file at the definition.
