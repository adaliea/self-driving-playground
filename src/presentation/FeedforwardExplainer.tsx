import { useEffect, useState, type ReactNode } from 'react';
import { cherry, ink, mint, panel, sun } from './theme';

/**
 * Two cars take the same curve. One only reacts to how far it has drifted
 * (feedback); the other also steers for the curve it can see (feedforward).
 */
export function FeedforwardExplainer() {
  const time = useLoopTime();
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-5">
      <div className="grid min-h-0 grid-cols-2 gap-5">
        <CarPanel
          title="Feedback only"
          subtitle="Waits until it has drifted, then corrects. Always a step behind."
          run={RUNS.feedback}
          color={cherry}
          time={time}
        />
        <CarPanel
          title="Feedforward + feedback"
          subtitle="Sees the curve coming and starts turning with it."
          run={RUNS.feedforward}
          color={mint}
          time={time}
          showLookahead
        />
      </div>
      <div className={`grid grid-cols-3 gap-6 px-6 py-4 ${panel}`}>
        <Idea color={cherry} title="Feedback">
          Measure the error, then correct it. It can't act until something has already gone wrong.
        </Idea>
        <Idea color={mint} title="Feedforward">
          Use what you know about what's coming, like how the road bends, to act before an error appears.
        </Idea>
        <Idea color={sun} title="Together">
          Feedforward does most of the work. Feedback cleans up whatever the prediction got wrong.
        </Idea>
        <div className="col-span-3 rounded-xl bg-[#1d1b2e] px-4 py-2 font-mono text-xl text-white">
          const steering = <span style={{ color: '#ff8fa0' }}>lanePid.update(lane.centerOffset, input.dt)</span> +{' '}
          <span style={{ color: mint }}>steeringFeedforward(lane.curvature, input.ego.speed)</span>;
        </div>
      </div>
    </div>
  );
}

function Idea({ color, title, children }: { color: string; title: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-2xl font-black">
        <span className="h-5 w-5 rounded-full border-[3px] border-[#1d1b2e]" style={{ background: color }} />
        {title}
      </div>
      <p className="mt-1 text-lg font-bold leading-snug opacity-80">{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The scenario: a straight, a left-hand curve, a straight

const ROAD_LENGTH = 200;
const CURVE_START = 60;
const CURVE_END = 130;
/** An 80 m radius curve, taken at 24 m/s (about 86 km/h). */
const CURVATURE = 1 / 80;
const SPEED = 24;
const DT = 1 / 120;
/** Feedforward's estimate of the curve is a little off, so feedback still has something to do. */
const FEEDFORWARD_ACCURACY = 0.9;
const LOOP_PAUSE = 1.2;

const curvatureAt = (s: number) => (s >= CURVE_START && s < CURVE_END ? CURVATURE : 0);
/**
 * What the lane-line fit reports: the average bend over the next 12 m, so it
 * starts seeing the curve shortly before the car reaches it.
 */
const curvatureAhead = (s: number) => {
  let sum = 0;
  for (let ahead = 0; ahead < 12; ahead += 1) sum += curvatureAt(s + ahead);
  return sum / 12;
};

interface RoadPoint {
  x: number;
  y: number;
  heading: number;
}

/** Centerline sampled every half meter, heading right then curving left (up the screen). */
const ROAD: RoadPoint[] = (() => {
  const points: RoadPoint[] = [{ x: 0, y: 0, heading: 0 }];
  for (let s = 0.5; s <= ROAD_LENGTH + 20; s += 0.5) {
    const previous = points[points.length - 1];
    const heading = previous.heading + curvatureAt(s - 0.5) * 0.5;
    points.push({ x: previous.x + Math.cos(heading) * 0.5, y: previous.y - Math.sin(heading) * 0.5, heading });
  }
  return points;
})();

function roadAt(s: number): RoadPoint {
  return ROAD[Math.max(0, Math.min(ROAD.length - 1, Math.round(s * 2)))];
}

interface RunSample {
  s: number;
  /** Meters left of the lane center. */
  offset: number;
  /** Heading relative to the road, radians. */
  heading: number;
}

/**
 * The car the way the game drives it: a lane PID (kp 0.5, kd 0.1) on the offset
 * from the lane center, the same steering lag, and full lock turning at 0.68 rad/s.
 */
function simulate(feedforward: boolean): RunSample[] {
  const samples: RunSample[] = [];
  let s = 0;
  let offset = 0;
  let heading = 0;
  let previousOffset = 0;
  let actualSteering = 0;
  while (s < ROAD_LENGTH && samples.length < 20_000) {
    // Steering is positive to the right; the car is `offset` meters left of center.
    const offsetRate = (offset - previousOffset) / DT;
    previousOffset = offset;
    let steering = 0.5 * offset + 0.1 * offsetRate;
    if (feedforward) steering -= (SPEED * curvatureAhead(s) * FEEDFORWARD_ACCURACY) / 0.68;
    steering = Math.max(-1, Math.min(1, steering));
    actualSteering += (steering - actualSteering) * Math.min(1, DT / 0.14);
    const turnRate = -0.68 * actualSteering;
    heading += (turnRate - SPEED * curvatureAt(s)) * DT;
    offset += SPEED * Math.sin(heading) * DT;
    s += SPEED * Math.cos(heading) * DT;
    samples.push({ s, offset, heading });
  }
  return samples;
}

const RUNS = { feedback: simulate(false), feedforward: simulate(true) };
const LOOP_SECONDS = RUNS.feedback.length * DT + LOOP_PAUSE;

function useLoopTime(): number {
  const [time, setTime] = useState(4.5);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      // The first frame's timestamp can be slightly before `start`.
      setTime(Math.max(0, (now - start) / 1000) % LOOP_SECONDS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return time;
}

// ---------------------------------------------------------------------------
// Drawing

/** Sideways distances are drawn this much larger so a meter of drift is easy to see. */
const LANE_HALF_WIDTH = 1.85;
/** Drawn at true scale, framed on the curve. */
const VIEW = (() => {
  const framed = ROAD.filter((_, index) => index / 2 >= CURVE_START - 25 && index / 2 <= CURVE_END + 30);
  const xs = framed.map((point) => point.x);
  const ys = framed.map((point) => point.y);
  const margin = 7;
  return { x: Math.min(...xs) - margin, y: Math.min(...ys) - margin, width: Math.max(...xs) - Math.min(...xs) + margin * 2, height: Math.max(...ys) - Math.min(...ys) + margin * 2 };
})();

/** World position of a point `offset` meters left of the centerline. */
function offsetPoint(s: number, offset: number): { x: number; y: number } {
  const point = roadAt(s);
  const left = offset;
  return { x: point.x - Math.sin(point.heading) * left, y: point.y - Math.cos(point.heading) * left };
}

function edgePath(offset: number, from = 0, to = ROAD_LENGTH + 20): string {
  const points: string[] = [];
  for (let s = from; s <= to; s += 1) {
    const point = offsetPoint(s, offset);
    points.push(`${points.length === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`);
  }
  return points.join('');
}

/** Three lanes; the car drives in the middle one. */
const ROAD_EDGES = {
  left: edgePath(LANE_HALF_WIDTH * 3),
  right: edgePath(-LANE_HALF_WIDTH * 3),
  leftLine: edgePath(LANE_HALF_WIDTH),
  rightLine: edgePath(-LANE_HALF_WIDTH),
  center: edgePath(0),
};

function CarPanel({
  title,
  subtitle,
  run,
  color,
  time,
  showLookahead = false,
}: {
  title: string;
  subtitle: string;
  run: RunSample[];
  color: string;
  time: number;
  showLookahead?: boolean;
}) {
  const index = Math.min(run.length - 1, Math.floor(time / DT));
  const sample = run[index];
  const position = offsetPoint(sample.s, sample.offset);
  const angle = -(roadAt(sample.s).heading + sample.heading) * (180 / Math.PI);
  const trail = run.slice(0, index + 1).filter((_, sampleIndex) => sampleIndex % 3 === 0);
  const worst = Math.max(...run.slice(0, index + 1).map((entry) => Math.abs(entry.offset)));
  const seesCurve = showLookahead && sample.s > CURVE_START - 25 && sample.s < CURVE_END;

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
      <div className="flex items-center justify-between border-b-[3px] border-[#1d1b2e] px-4 py-2" style={{ background: color }}>
        <span className="text-2xl font-black">{title}</span>
        <span className="rounded-lg border-[3px] border-[#1d1b2e] bg-white px-2 text-lg font-black tabular-nums">
          off center: {worst.toFixed(1)} m
        </span>
      </div>
      <p className="px-4 pt-2 text-lg font-bold opacity-75">{subtitle}</p>
      <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`} className="min-h-0 w-full flex-1">
        <path d={ROAD_EDGES.center} fill="none" stroke="#565d6e" strokeWidth={LANE_HALF_WIDTH * 6} strokeLinejoin="round" />
        <path d={ROAD_EDGES.left} fill="none" stroke="#fff6d5" strokeWidth={0.3} />
        <path d={ROAD_EDGES.right} fill="none" stroke="#fff6d5" strokeWidth={0.3} />
        <path d={ROAD_EDGES.leftLine} fill="none" stroke="#fff6d5" strokeWidth={0.2} strokeDasharray="2 2.5" />
        <path d={ROAD_EDGES.rightLine} fill="none" stroke="#fff6d5" strokeWidth={0.2} strokeDasharray="2 2.5" />
        <path d={ROAD_EDGES.center} fill="none" stroke="#ffffff" strokeWidth={0.12} strokeDasharray="0.5 0.8" opacity={0.45} />
        {seesCurve ? (
          <path
            d={edgePath(0, Math.max(CURVE_START, sample.s), Math.min(CURVE_END, sample.s + 30))}
            fill="none"
            stroke={sun}
            strokeWidth={1.2}
            strokeLinecap="round"
            opacity={0.9}
          />
        ) : null}
        {trail.map((entry, trailIndex) => {
          const point = offsetPoint(entry.s, entry.offset);
          const drift = Math.min(1, Math.abs(entry.offset) / 1.2);
          return <circle key={trailIndex} cx={point.x} cy={point.y} r={0.3} fill={drift > 0.25 ? cherry : ink} opacity={0.25 + drift * 0.6} />;
        })}
        <g transform={`translate(${position.x} ${position.y}) rotate(${angle})`}>
          <rect x={-2.3} y={-0.95} width={4.6} height={1.9} rx={0.55} fill={color} stroke={ink} strokeWidth={0.3} />
          <rect x={0.5} y={-0.65} width={1.1} height={1.3} rx={0.25} fill="#c9e8ff" stroke={ink} strokeWidth={0.18} />
        </g>
        {seesCurve ? (
          <text x={position.x + 3} y={position.y - 3} fontSize={3} fontWeight={900} fill={ink}>
            curve ahead!
          </text>
        ) : null}
      </svg>
      <OffsetChart run={run} index={index} color={color} />
    </div>
  );
}

function OffsetChart({ run, index, color }: { run: RunSample[]; index: number; color: string }) {
  const width = 600;
  const height = 70;
  const maxOffset = 2;
  const x = (sampleIndex: number) => (sampleIndex / run.length) * width;
  const y = (offset: number) => height / 2 - (offset / maxOffset) * (height / 2 - 4);
  const line = run
    .slice(0, index + 1)
    .filter((_, sampleIndex) => sampleIndex % 2 === 0)
    .map((entry, position) => `${position === 0 ? 'M' : 'L'}${x(position * 2).toFixed(1)},${y(entry.offset).toFixed(1)}`)
    .join('');
  return (
    <div className="border-t-[3px] border-[#1d1b2e] px-4 py-2">
      <div className="text-sm font-black opacity-60">distance from the lane center</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full" preserveAspectRatio="none">
        <rect x={x(run.findIndex((entry) => entry.s >= CURVE_START))} width={x(run.findIndex((entry) => entry.s >= CURVE_END)) - x(run.findIndex((entry) => entry.s >= CURVE_START))} y={0} height={height} fill={sun} opacity={0.25} />
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke={ink} strokeOpacity={0.3} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <path d={line} fill="none" stroke={color === mint ? '#009e88' : color} strokeWidth={4} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
