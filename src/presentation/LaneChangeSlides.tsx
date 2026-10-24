import { useEffect, useState, type ReactNode } from 'react';
import { ToolboxVisual } from '../ui/ToolboxVisuals';
import { bubblegum, cherry, ink, mint, panel, sky, sun } from './theme';

// ---------------------------------------------------------------------------
// Before we start racing

const RACE_STEPS: { title: string; body: ReactNode }[] = [
  { title: 'Turn off "Steer for me"', body: 'Races run without assists, so your steering has to work on its own.' },
  { title: 'Press Submit to race', body: 'It appears once racing opens. The server test-drives your car for 30 seconds first; cars that block traffic or keep crashing are sent back.' },
  { title: 'Keep improving', body: 'Your latest submitted version races from the next round. Submit again whenever you like.' },
  { title: 'Fallen behind?', body: '"Catch up to presenter" gives you a car that is ready to race.' },
];

export function BeforeRacing() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] gap-5">
      <div className={`flex min-h-0 flex-col gap-4 overflow-auto p-6 ${panel}`}>
        <h2 className="text-3xl font-black">How racing works</h2>
        <ol className="grid gap-4">
          {RACE_STEPS.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[3px] border-[#1d1b2e] text-xl font-black"
                style={{ background: [sky, sun, bubblegum, mint][index] }}
              >
                {index + 1}
              </span>
              <div>
                <div className="text-xl font-black">{step.title}</div>
                <div className="text-lg font-bold leading-snug opacity-75">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-auto rounded-2xl border-[3px] border-[#1d1b2e] px-4 py-3 text-lg font-bold" style={{ background: sun }}>
          Score = meters driven, minus points for every crash you cause or are in, and for every time you hit the road edge.
        </div>
      </div>

      <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
        <div className="flex items-center gap-3 border-b-[3px] border-[#1d1b2e] px-5 py-2" style={{ background: mint }}>
          <span className="rounded-lg border-[3px] border-[#1d1b2e] bg-white px-2 text-base font-black">Unlocked</span>
          <span className="text-2xl font-black">Fastest Lane Selection</span>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-4 p-5">
          <div className="min-h-0 overflow-hidden rounded-xl border-[3px] border-[#1d1b2e] bg-[#070b0d] p-3">
            <ToolboxVisual snippetId="fastest-lane" />
          </div>
          <div className="grid gap-3">
            <p className="text-xl font-bold leading-snug">
              Stuck behind slow traffic? A lane chooser picks the faster lane next to you, waits for room, and tells your steering which lane to aim for.
            </p>
            <CodeBlock>
              <Comment>{'// Above autopilot:'}</Comment>
              {'\n'}
              <Keyword>const</Keyword> laneChooser = createLaneChooser({'{'} minSpeedGain: <NumberLiteral>3</NumberLiteral> {'}'});
              {'\n\n'}
              <Comment>{'// In autopilot, aim for the lane it picks instead of your home lane:'}</Comment>
              {'\n'}
              <Keyword>const</Keyword> lane = analyzeLane(input.laneLines, <Highlight>laneChooser.update(input)</Highlight>);
            </CodeBlock>
            <p className="text-lg font-bold opacity-75">Changing lanes makes your lane PID's error jump by a whole lane. Watch what your car does.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lane changes: PID on the offset vs. lateral velocity control

const SPEED = 25;
const DT = 1 / 120;
const LANE_WIDTH = 3.7;
/** Seconds of straight driving before the lane change starts. */
const CHANGE_AT = 1;
const RUN_SECONDS = 7;
const LOOP_PAUSE = 1.2;
const MAX_SIDEWAYS_SPEED = 1.5;

interface LaneChangeSample {
  x: number;
  /** Meters left of the starting lane's center. */
  y: number;
  /** Heading, radians, positive to the left. */
  heading: number;
  sidewaysSpeed: number;
  steering: number;
}

/**
 * One lane change to the left, driven like the game drives: steering with a
 * 0.14 s lag, full lock turning at 0.68 rad/s.
 */
function simulateLaneChange(mode: 'pid' | 'lateral-velocity'): LaneChangeSample[] {
  const samples: LaneChangeSample[] = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  let actualSteering = 0;
  let previousError = 0;
  for (let time = 0; time < RUN_SECONDS; time += DT) {
    const target = time >= CHANGE_AT ? LANE_WIDTH : 0;
    // The PIDs' error: lane center to the right of the car is positive.
    const centerOffset = y - target;
    const errorRate = (centerOffset - previousError) / DT;
    previousError = centerOffset;
    let steering: number;
    if (mode === 'pid') {
      steering = 0.5 * centerOffset + 0.1 * errorRate;
    } else {
      // Outer loop: a sideways speed toward the lane center, capped. Inner loop: hold it.
      const maxSideways = Math.min(MAX_SIDEWAYS_SPEED, SPEED * Math.sin(0.26));
      const targetRight = Math.max(-maxSideways, Math.min(maxSideways, 1.0 * centerOffset));
      const targetHeadingRight = Math.asin(targetRight / SPEED);
      const headingRight = -heading;
      const sidewaysRight = SPEED * Math.sin(headingRight);
      steering = (targetHeadingRight - headingRight) * 1.55 + (targetRight - sidewaysRight) * 0.095;
    }
    steering = Math.max(-1, Math.min(1, steering));
    actualSteering += (steering - actualSteering) * Math.min(1, DT / 0.14);
    heading += -0.68 * actualSteering * DT;
    x += SPEED * Math.cos(heading) * DT;
    y += SPEED * Math.sin(heading) * DT;
    samples.push({ x, y, heading, sidewaysSpeed: SPEED * Math.sin(heading), steering });
  }
  return samples;
}

const LANE_CHANGES = { pid: simulateLaneChange('pid'), smooth: simulateLaneChange('lateral-velocity') };
const LANE_LOOP_SECONDS = RUN_SECONDS + LOOP_PAUSE;

function useLoopClock(loop: number, stillAt: number): number {
  const [time, setTime] = useState(stillAt);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setTime(Math.max(0, (now - start) / 1000) % loop);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop]);
  return time;
}

export function LaneChangeQuestion() {
  const time = useLoopClock(LANE_LOOP_SECONDS, 4);
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-5">
      <div className="grid min-h-0 grid-rows-2 gap-5">
        <LaneChangePanel title="PID on the lane offset" subtitle="The error jumps by a whole lane, so it yanks the wheel." run={LANE_CHANGES.pid} color={cherry} time={time} />
        <LaneChangePanel title="??? Mystery controller" subtitle="Slides over at a steady, comfortable speed." run={LANE_CHANGES.smooth} color={mint} time={time} />
      </div>
      <div className={`flex items-center gap-4 px-6 py-4 ${panel}`} style={{ background: sun }}>
        <span className="text-4xl">🤔</span>
        <p className="text-2xl font-black leading-snug">
          When you change lanes, do you yank the wheel toward the new lane? Or do you drift over at a steady sideways speed?
        </p>
      </div>
    </div>
  );
}

/** Meters of road in view; the camera follows the car. */
const VIEW_LENGTH = 75;
/** Lanes drawn: the starting lane, the target lane, and the one beyond it. */
const VIEW_LANES = 3;

function LaneChangePanel({
  title,
  subtitle,
  run,
  color,
  time,
}: {
  title: string;
  subtitle: string;
  run: LaneChangeSample[];
  color: string;
  time: number;
}) {
  const index = Math.min(run.length - 1, Math.floor(time / DT));
  const sample = run[index];
  const peakSideways = Math.max(...run.slice(0, index + 1).map((entry) => Math.abs(entry.sidewaysSpeed)));
  const overshoot = Math.max(0, ...run.slice(0, index + 1).map((entry) => entry.y - LANE_WIDTH));
  // Road is drawn with lane 0 (start) at the bottom; y up the screen is left of travel.
  const roadTop = -LANE_WIDTH * (VIEW_LANES - 0.5);
  const toScreenY = (y: number) => -y;
  const viewStart = Math.max(-5, sample.x - 28);
  const trail = run.slice(0, index + 1).filter((entry, sampleIndex) => sampleIndex % 4 === 0 && entry.x > viewStart - 2);

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
      <div className="flex items-center justify-between border-b-[3px] border-[#1d1b2e] px-4 py-2" style={{ background: color }}>
        <span className="text-2xl font-black">
          {title}
          <span className="ml-3 text-lg font-bold opacity-80">{subtitle}</span>
        </span>
        <span className="rounded-lg border-[3px] border-[#1d1b2e] bg-white px-2 text-lg font-black tabular-nums">
          {peakSideways.toFixed(1)} m/s sideways
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem]">
        <svg viewBox={`${viewStart} ${roadTop - 1.5} ${VIEW_LENGTH} ${LANE_WIDTH * VIEW_LANES + 3}`} className="h-full min-h-0 w-full" preserveAspectRatio="xMidYMid meet">
          <rect x={viewStart} y={roadTop} width={VIEW_LENGTH} height={LANE_WIDTH * VIEW_LANES} fill="#565d6e" />
          {[1, 2].map((line) => (
            <line
              key={line}
              x1={viewStart}
              x2={viewStart + VIEW_LENGTH}
              y1={toScreenY(-LANE_WIDTH / 2 + line * LANE_WIDTH)}
              y2={toScreenY(-LANE_WIDTH / 2 + line * LANE_WIDTH)}
              stroke="#fff6d5"
              strokeWidth={0.15}
              strokeDasharray="3 3"
            />
          ))}
          <line x1={viewStart} x2={viewStart + VIEW_LENGTH} y1={roadTop} y2={roadTop} stroke="#fff6d5" strokeWidth={0.2} />
          <line x1={viewStart} x2={viewStart + VIEW_LENGTH} y1={roadTop + LANE_WIDTH * VIEW_LANES} y2={roadTop + LANE_WIDTH * VIEW_LANES} stroke="#fff6d5" strokeWidth={0.2} />
          {/* Target lane center, once the change starts */}
          <line
            x1={Math.max(viewStart, CHANGE_AT * SPEED)}
            x2={viewStart + VIEW_LENGTH}
            y1={toScreenY(LANE_WIDTH)}
            y2={toScreenY(LANE_WIDTH)}
            stroke={sun}
            strokeWidth={0.15}
            strokeDasharray="0.6 0.6"
          />
          {trail.map((entry, trailIndex) => (
            <circle key={trailIndex} cx={entry.x} cy={toScreenY(entry.y)} r={0.18} fill={entry.y > LANE_WIDTH + 0.4 ? cherry : '#fff6d5'} opacity={0.7} />
          ))}
          <g transform={`translate(${sample.x} ${toScreenY(sample.y)}) rotate(${(-sample.heading * 180) / Math.PI})`}>
            <rect x={-2.3} y={-0.95} width={4.6} height={1.9} rx={0.55} fill={color} stroke={ink} strokeWidth={0.2} />
            <rect x={0.5} y={-0.65} width={1.1} height={1.3} rx={0.25} fill="#c9e8ff" stroke={ink} strokeWidth={0.12} />
          </g>
        </svg>
        <div className="flex flex-col justify-center gap-1 border-l-[3px] border-[#1d1b2e] px-4 py-2">
          <MiniChart label="steering" run={run} index={index} pick={(entry) => entry.steering} range={1} color={color} />
          <MiniChart label="sideways speed" run={run} index={index} pick={(entry) => entry.sidewaysSpeed} range={8} color={color} />
          <div className="text-base font-black opacity-70">
            {overshoot > 0.3
              ? `Overshot the new lane by ${overshoot.toFixed(1)} m`
              : time > CHANGE_AT + 4
                ? 'Landed in the new lane without overshooting'
                : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniChart({
  label,
  run,
  index,
  pick,
  range,
  color,
}: {
  label: string;
  run: LaneChangeSample[];
  index: number;
  pick: (sample: LaneChangeSample) => number;
  range: number;
  color: string;
}) {
  const width = 400;
  const height = 60;
  const x = (sampleIndex: number) => (sampleIndex / run.length) * width;
  const y = (value: number) => height / 2 - (value / range) * (height / 2 - 3);
  const line = run
    .slice(0, index + 1)
    .filter((_, sampleIndex) => sampleIndex % 3 === 0)
    .map((entry, position) => `${position === 0 ? 'M' : 'L'}${x(position * 3).toFixed(1)},${y(pick(entry)).toFixed(1)}`)
    .join('');
  return (
    <div>
      <div className="text-sm font-black opacity-60">{label}</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full" preserveAspectRatio="none">
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke={ink} strokeOpacity={0.3} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <path d={line} fill="none" stroke={color === mint ? '#009e88' : color} strokeWidth={4} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lateral velocity control explained

export function LateralVelocityExplainer() {
  const time = useLoopClock(3, 1.2);
  const pulse = time / 3;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5">
      <div className={`flex items-center justify-between gap-3 px-6 py-5 ${panel}`}>
        <FlowBox color={sky} title="Distance to the lane center" detail="lane.centerOffset" />
        <FlowArrow progress={pulse} label="your PID" />
        <FlowBox color={sun} title="How fast to slide over" detail="capped at 1.5 m/s" />
        <FlowArrow progress={(pulse + 0.33) % 1} label="lateralVelocitySteering" />
        <FlowBox color={mint} title="Steering" detail="holds that sideways speed" />
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-5">
        <div className={`flex min-h-0 flex-col gap-4 overflow-auto p-6 ${panel}`}>
          <h2 className="text-3xl font-black">Two loops instead of one</h2>
          <p className="text-xl font-bold leading-snug">
            Your PID no longer steers. It decides <b>how fast to slide toward the lane center</b>. A second controller, already in your
            Toolbox, steers to hold that sideways speed.
          </p>
          <ul className="grid gap-2 text-xl font-bold">
            <li>🛣️ Capping the sideways speed makes every lane change smooth and predictable.</li>
            <li>🎯 The same code keeps you centered and changes lanes.</li>
            <li>🔧 Tune one simple gain: how quickly to slide back toward the center.</li>
          </ul>
          <CodeBlock>
            <Comment>{'// Outer loop: how fast to slide toward the lane center, in m/s.'}</Comment>
            {'\n'}
            <Keyword>const</Keyword> lateralPid = createPidController({'{'}
            {'\n  '}kp: <NumberLiteral>1</NumberLiteral>, ki: <NumberLiteral>0</NumberLiteral>, kd: <NumberLiteral>0</NumberLiteral>,
            {'\n  '}outputMin: <NumberLiteral>-1.5</NumberLiteral>, outputMax: <NumberLiteral>1.5</NumberLiteral>,
            {'\n'}
            {'});'}
            {'\n\n'}
            <Comment>{'// Inner loop: Toolbox → Lateral Velocity Steering.'}</Comment>
            {'\n'}
            <Keyword>const</Keyword> steering = <Highlight>lateralVelocitySteering</Highlight>(input,
            {'\n  '}lateralPid.update(lane.centerOffset, input.dt));
          </CodeBlock>
        </div>
        <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
          <div className="border-b-[3px] border-[#1d1b2e] px-5 py-2 text-2xl font-black" style={{ background: mint }}>
            The mystery controller
          </div>
          <div className="min-h-0 flex-1 p-4">
            <div className="h-full overflow-hidden rounded-xl border-[3px] border-[#1d1b2e] bg-[#070b0d] p-3">
              <ToolboxVisual snippetId="lateral-velocity" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FlowBox({ color, title, detail }: { color: string; title: string; detail: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-2xl border-[3px] border-[#1d1b2e] px-4 py-3 text-center" style={{ background: color }}>
      <div className="text-2xl font-black leading-tight">{title}</div>
      <div className="mt-1 font-mono text-base font-bold opacity-75">{detail}</div>
    </div>
  );
}

function FlowArrow({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="flex w-56 shrink-0 flex-col items-center">
      <span className="mb-1 font-mono text-sm font-bold">{label}</span>
      <div className="relative h-3 w-full rounded-full bg-[#1d1b2e]/15">
        <div className="absolute -right-1 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[10px] border-l-[14px] border-y-transparent border-l-[#1d1b2e]" />
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[#1d1b2e] bg-white"
          style={{ left: `${progress * 92}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code styling for the light slides

function CodeBlock({ children }: { children: ReactNode }) {
  return <pre className="overflow-auto whitespace-pre rounded-xl bg-[#1d1b2e] px-4 py-3 font-mono text-lg leading-relaxed text-white">{children}</pre>;
}

function Comment({ children }: { children: ReactNode }) {
  return <span className="text-[#8fa1a6]">{children}</span>;
}

function Keyword({ children }: { children: ReactNode }) {
  return <span className="text-[#89a9ff]">{children}</span>;
}

function NumberLiteral({ children }: { children: ReactNode }) {
  return <span className="text-[#f7c86d]">{children}</span>;
}

function Highlight({ children }: { children: ReactNode }) {
  return <span className="rounded bg-[#00c2a8]/30 px-1 text-[#6df7d1]">{children}</span>;
}
