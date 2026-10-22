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

Cloudflare Workers preview and deployment:

```bash
npx wrangler login
npm run preview:cloudflare
npm run deploy:dry-run
npm run deploy
```

The Workers config in `wrangler.jsonc` serves the Vite build as static assets with single-page-app fallback, routes `/api/*` to the Worker first, and binds the `Room` Durable Object used for multiplayer. `npm run deploy` builds before deploying.

Headless traffic/personality report:

```bash
npm run traffic:report -- --density 0.9 --runs 3 --seconds 90 --warmup 15 --start-speed 24
```

This runs built-in traffic outside the user-code runner and reports traffic wave strength, speed spread, physical clearance, lane-keeping quality, assigned-lane exits, road exits, flow, collision events, hard braking events, lane changes, and per-personality behavior. Use `--noisy-lanes`, `--noisy-vehicles`, `--actuator-variation`, or `--json` for alternate test modes.

## Multiplayer Races

Open `/host` on the presenter screen. It creates a room and shows a five-character code. Players open `/play` (or `/play/CODE`), enter the code and a display name, then use the normal editor and simulator to practice. **Submit to race** sends the current code once it compiles locally.

- The presenter's browser is authoritative. It compiles every submission and runs each player's driver in its own sandboxed iframe and worker, steps one shared simulation, and scores rounds. The room server never executes user code, and other players never receive anyone's source.
- Rounds restart automatically (default 90 s race, 12 s break, adjustable under **Host controls**). Each round uses a new seed and a shuffled starting grid. A player's latest successfully compiled version races until they submit another. New versions take over at the next round, and a version that fails to compile leaves the previous one racing.
- Score per round = meters driven − 150 per collision the player caused − 25 per collision they were involved in. Causing a collision also cuts throttle for 1.5 s. Fault goes to the follower in a rear-end, to a car that cuts in sharply, and in side contacts to the car moving sideways (or drifted farther from its lane). The leaderboard ranks total points across rounds and also shows each player's best round.
- A driver that exceeds its 28 ms budget for 30 consecutive steps coasts for the rest of the round. Runtime errors are reported back to that player.
- Race settings: noisy lanes and vehicles, actuator variation, no assists. Players can load the same settings locally with **Practice with race settings**.

The room server is a Cloudflare Worker (`worker/`) with one Durable Object per room, using hibernatable WebSockets. `npm run dev` runs it locally through `@cloudflare/vite-plugin`. It stores players, their latest source, the round state, and the leaderboard for up to 24 hours of inactivity. It enforces a 64 KB source limit, a 3 s submission interval, and a maximum of 40 players per room, and only the host token may publish round state or leaderboards.

## Project Structure

```text
src/
  simulation/  deterministic road generation, sensors, vehicle physics, traffic, controllers
  rendering/   direct Canvas 2D renderer; simulator objects are not rendered through React
  sandbox/     TypeScript transpilation and sandboxed iframe/worker client
  toolbox/     insertable helper snippets and built-in controller examples
  types/       documented public autopilot API types
  ui/          React/Tailwind controls, Monaco editor, telemetry, toolbox menus
  multiplayer/ room protocol, host race engine and scoring, presenter and player views
worker/        Cloudflare Worker and room Durable Object
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

The editor exposes documented public types for `AutopilotInput`, `AutopilotOutput`, vehicle detections, and lane-line samples. Vehicle detections include noisy ego-relative position, velocity, dimensions, and `relativeHeading` yaw. The simulator clamps invalid `motor` and `steering` values to `[-1, 1]` and ignores untrusted fields for physics.

## Sandbox Model

The main React app does not execute user code directly. It transpiles TypeScript to CommonJS JavaScript, then sends it by `postMessage` to `public/sandbox.html`, which is mounted as a hidden iframe with restrictive sandbox attributes. The iframe creates a Blob Web Worker for user code and communicates only through validated structured messages.

The worker blocks common network and storage APIs where feasible, including `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `localStorage`, `sessionStorage`, `indexedDB`, and `caches`. Each autopilot call has a frame budget; if user code hangs, the iframe terminates and recreates the worker.

Current limitations:

- This browser sandbox is a defense-in-depth MVP, not a full security boundary against a determined attacker.
- Browser memory limits cannot be precisely enforced from JavaScript.
- Multiplayer scoring trusts the presenter's browser, not the players' browsers. Fully server-side replay and scoring would need a controlled environment that can run untrusted code.

## Simulation Model

- Road generation is deterministic from a seed and uses smooth base curvature plus localized turn features sampled into a 3-lane highway.
- Vehicles use Frenet-like coordinates over the road centerline.
- Longitudinal dynamics include nonlinear acceleration, braking, and drag.
- Steering has actuator smoothing and road-curvature-relative heading dynamics.
- Traffic uses the same normalized controller output shape as ego controllers, with built-in lane centering, adaptive speed control, target-lane changes, varied driving personalities, and mixed lane-control models.
- Ego assist uses the same user-facing sensor inputs as user code, but runs stronger lateral-velocity lane keeping and adaptive cruise controllers.
- Sensors produce ego-relative oriented vehicle boxes and lane-line samples. Vehicle pose noise is anisotropic, distance-scaled, temporally correlated, occasionally heavy-tailed, filtered, and subject to missed detections. Lane-line sampling is denser near the ego vehicle.

The rationale, approximate error profile, source research, and physics-engine recommendation are documented in [Vision pose noise and vehicle physics](docs/vision-noise-and-physics.md).

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

The default example is a working PID lane-keeping controller with comments explaining the P, I, and D terms. PID terms appear automatically in telemetry, labeled with the controller variable name (for example, `lanePid` or `speedPid`). No debug configuration or return fields are needed. Each PID card includes a collapsed-by-default 30-second history graph of error, P, I, D, their sum, and the limited output. ECharts provides hover inspection, wheel zoom, drag panning, a range slider, and image export. Error uses a separate scale from output contributions. Open **Explore telemetry** for a single fullscreen graph workspace. The **Lead vehicle** group includes estimated forward speed, relative forward/lateral velocity, distance ahead, and lateral offset from the same tracked vehicle the controller sees. Missing leads produce gaps; positive relative forward velocity means the lead is pulling away. Select any combination of speed, lead vehicle, motor, steering, and PID signals from the searchable signal list. Add, rename, or remove graph tabs for separate selections, and adjust graph height. Vehicle plots compare autopilot commands, commands after assists, and actual actuation. History records while graphs are closed; **Hold history** freezes the view without pausing the simulation. Graphs use simulation time and reset when the simulation resets or code changes.

## Toolbox

The toolbox panel provides inspectable TypeScript helpers from a virtual `autopilot-toolbox.ts` file:

- `clamp`
- vehicle lane filtering and closest-vehicle-ahead
- stateful PID controller object
- lane-line interpretation
- acceleration feedforward
- adaptive cruise target-speed snippet

Each helper can insert a short usage example at the bottom of the editor. The implementations stay out of `Autopilot.ts`, but Monaco can still navigate to them with Go to Definition / Ctrl-click, opening the read-only toolbox file at the definition.

### Local lane regression and preview

`analyzeLaneRegression(input.laneLines)` and `analyzeTargetLane(input)` default to
fitting the nearest 3–21 meters of lane samples and estimating geometry at ego.
Use this local geometry for steering so distant corner entries and exits do not
advance the steering response. Existing calls receive this behavior automatically.

For the original longer 5–56 meter fit, select `"preview"` when planning speed:

```ts
const lane = analyzeTargetLane(input); // Local steering geometry.
const preview = analyzeTargetLane(input, "preview"); // Upcoming road geometry.
// The built-in helper also accepts the mode directly:
const relativeLane = input.targetLane - input.ego.laneIndex;
const previewLane = analyzeLaneRegression(input.laneLines, relativeLane, "preview");
```
