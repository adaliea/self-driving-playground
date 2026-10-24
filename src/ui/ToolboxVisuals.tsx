import { useEffect, useState, type ReactNode } from 'react';

/**
 * Animated diagrams for the toolbox menu, one per snippet. Each is an SVG drawn
 * as a pure function of the animation time, so it loops without stored state.
 */

const W = 320;
const H = 180;

const COLOR = {
  signal: 'hsl(var(--signal))',
  warning: 'hsl(var(--warning))',
  muted: 'hsl(var(--muted-foreground))',
  foreground: 'hsl(var(--foreground))',
  grid: 'hsl(var(--border))',
  asphalt: 'hsl(200 14% 9%)',
  laneLine: 'hsl(195 8% 36%)',
  traffic: 'hsl(205 14% 46%)',
  inLane: '#89a9ff',
};

interface VisualDefinition {
  label: string;
  caption: string;
  /** Time shown when the user prefers reduced motion. */
  stillAt: number;
  draw: (t: number) => ReactNode;
}

export function ToolboxVisual({ snippetId }: { snippetId: string }) {
  const visual = visuals[snippetId];
  const t = useAnimationClock(visual?.stillAt ?? 0, snippetId);
  if (!visual) return null;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full rounded-md border border-border bg-background"
        role="img"
        aria-label={visual.label}
        fontFamily='"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif'
        fontSize={9}
      >
        {visual.draw(t)}
      </svg>
      <figcaption className="mt-2 text-xs leading-5 text-muted-foreground">{visual.caption}</figcaption>
    </figure>
  );
}

function useAnimationClock(stillAt: number, restartKey: string): number {
  const [t, setT] = useState(stillAt);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setT(stillAt);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setT((now - start) / 1000);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [stillAt, restartKey]);
  return t;
}

// ---------------------------------------------------------------------------
// Shared drawing helpers

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const smoothstep = (x: number) => {
  const u = clampNumber(x, 0, 1);
  return u * u * (3 - 2 * u);
};
const mod = (value: number, period: number) => ((value % period) + period) % period;

function path(points: Array<[number, number]>): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
}

function Text({
  x,
  y,
  children,
  anchor = 'start',
  color = COLOR.muted,
  size = 9,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: 'start' | 'middle' | 'end';
  color?: string;
  size?: number;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={color} fontSize={size}>
      {children}
    </text>
  );
}

/** Top-down car, nose pointing right. x and y are its center. */
function Car({
  x,
  y,
  length,
  width,
  color,
  heading = 0,
  outline,
  opacity = 1,
}: {
  x: number;
  y: number;
  length: number;
  width: number;
  color: string;
  heading?: number;
  outline?: string;
  opacity?: number;
}) {
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${((heading * 180) / Math.PI).toFixed(2)})`} opacity={opacity}>
      {outline ? (
        <rect x={-length / 2 - 2.5} y={-width / 2 - 2.5} width={length + 5} height={width + 5} rx={3.5} fill="none" stroke={outline} strokeWidth={1.2} />
      ) : null}
      <rect x={-length / 2} y={-width / 2} width={length} height={width} rx={2.5} fill={color} />
      <rect x={length * 0.08} y={-width / 2 + 1.5} width={length * 0.2} height={width - 3} rx={1} fill="hsl(200 30% 4%)" opacity={0.45} />
    </g>
  );
}

/** Straight road running left to right with lanes stacked top to bottom. */
function StraightRoad({
  top,
  laneWidth,
  lanes,
  scroll,
  highlightLane,
}: {
  top: number;
  laneWidth: number;
  lanes: number;
  scroll: number;
  highlightLane?: number;
}) {
  const bottom = top + laneWidth * lanes;
  return (
    <g>
      <rect x={0} y={top} width={W} height={bottom - top} fill={COLOR.asphalt} />
      {highlightLane !== undefined ? (
        <rect x={0} y={top + highlightLane * laneWidth} width={W} height={laneWidth} fill={COLOR.signal} opacity={0.07} />
      ) : null}
      <line x1={0} x2={W} y1={top} y2={top} stroke={COLOR.laneLine} strokeWidth={1.2} />
      <line x1={0} x2={W} y1={bottom} y2={bottom} stroke={COLOR.laneLine} strokeWidth={1.2} />
      {Array.from({ length: lanes - 1 }, (_, index) => (
        <line
          key={index}
          x1={0}
          x2={W}
          y1={top + (index + 1) * laneWidth}
          y2={top + (index + 1) * laneWidth}
          stroke={COLOR.laneLine}
          strokeWidth={1}
          strokeDasharray="10 12"
          strokeDashoffset={mod(scroll, 22)}
        />
      ))}
    </g>
  );
}

function Swatch({ x, y, color, dashed = false, label }: { x: number; y: number; color: string; dashed?: boolean; label: string }) {
  return (
    <g>
      <line x1={x} x2={x + 12} y1={y - 3} y2={y - 3} stroke={color} strokeWidth={1.6} strokeDasharray={dashed ? '3 2' : undefined} />
      <Text x={x + 16} y={y}>{label}</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Clamp

function drawClamp(t: number): ReactNode {
  const left = 26;
  const right = 304;
  const center = 84;
  const unit = 44;
  const span = 4;
  const signal = (time: number) => 1.45 * Math.sin(1.7 * time) + 0.35 * Math.sin(4.3 * time + 1);
  const samples = Array.from({ length: 141 }, (_, index) => {
    const time = t - span + (span * index) / 140;
    const value = signal(time);
    return { x: left + ((right - left) * index) / 140, value, clamped: clampNumber(value, -1, 1) };
  });
  const toY = (value: number) => center - value * unit;
  const saturatedRuns: Array<Array<[number, number]>> = [];
  for (const sample of samples) {
    if (Math.abs(sample.value) <= 1) continue;
    const point: [number, number] = [sample.x, toY(sample.clamped)];
    const previous = saturatedRuns[saturatedRuns.length - 1];
    if (previous && Math.abs(previous[previous.length - 1][0] - sample.x) < 2.5 && Math.abs(previous[previous.length - 1][1] - point[1]) < 1) {
      previous.push(point);
    } else {
      saturatedRuns.push([point]);
    }
  }
  const head = samples[samples.length - 1];

  return (
    <g>
      <rect x={left} y={toY(1)} width={right - left} height={unit * 2} fill={COLOR.signal} opacity={0.05} />
      <line x1={left} x2={right} y1={toY(1)} y2={toY(1)} stroke={COLOR.warning} strokeWidth={0.8} strokeDasharray="2 3" />
      <line x1={left} x2={right} y1={toY(-1)} y2={toY(-1)} stroke={COLOR.warning} strokeWidth={0.8} strokeDasharray="2 3" />
      <line x1={left} x2={right} y1={center} y2={center} stroke={COLOR.grid} />
      <Text x={left - 5} y={toY(1) + 3} anchor="end">+1</Text>
      <Text x={left - 5} y={center + 3} anchor="end">0</Text>
      <Text x={left - 5} y={toY(-1) + 3} anchor="end">−1</Text>
      <path d={path(samples.map((sample) => [sample.x, toY(sample.value)]))} fill="none" stroke={COLOR.muted} strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={path(samples.map((sample) => [sample.x, toY(sample.clamped)]))} fill="none" stroke={COLOR.signal} strokeWidth={2} />
      {saturatedRuns.map((run, index) => (
        <path key={index} d={path(run.length > 1 ? run : [run[0], [run[0][0] + 0.5, run[0][1]]])} fill="none" stroke={COLOR.warning} strokeWidth={2.6} strokeLinecap="round" />
      ))}
      {Math.abs(head.value) > 1 ? (
        <line x1={head.x} x2={head.x} y1={toY(head.value)} y2={toY(head.clamped)} stroke={COLOR.warning} strokeWidth={1} />
      ) : null}
      <circle cx={head.x} cy={toY(head.value)} r={2.5} fill={COLOR.muted} />
      <circle cx={head.x} cy={toY(head.clamped)} r={3.5} fill={Math.abs(head.value) > 1 ? COLOR.warning : COLOR.signal} />
      <Swatch x={left} y={170} color={COLOR.muted} dashed label="value in" />
      <Swatch x={left + 72} y={170} color={COLOR.signal} label="value out" />
      <Swatch x={left + 148} y={170} color={COLOR.warning} label="held at the limit" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Vehicle filtering

function drawVehicleFiltering(t: number): ReactNode {
  const scale = 8;
  const laneWidth = 3.7 * scale;
  const top = 42;
  const egoX = 34;
  const egoLaneCenter = top + laneWidth * 1.5;
  const toX = (meters: number) => egoX + meters * scale;
  const toY = (lateral: number) => egoLaneCenter + lateral * scale;

  // Positions relative to ego: ahead in meters, lateral in meters (positive is right).
  const cutInPhase = mod(t, 10) / 10;
  // Merges in from the right lane, then moves back out at the end of the loop.
  const cutInLateral = 3.7 * (1 - smoothstep((cutInPhase - 0.25) / 0.3) + smoothstep((cutInPhase - 0.85) / 0.15));
  const vehicles = [
    { id: 'lead', ahead: 26 + 3 * Math.sin(t * 0.5), lateral: 0.15 * Math.sin(t * 0.8), heading: 0 },
    { id: 'left', ahead: mod(4 + t * 4, 46) - 6, lateral: -3.7, heading: 0 },
    {
      id: 'cut-in',
      ahead: 14 + 2 * Math.sin(t * 0.3),
      lateral: cutInLateral,
      heading: -0.14 * Math.sin(Math.PI * clampNumber((cutInPhase - 0.25) / 0.3, 0, 1)) + 0.14 * Math.sin(Math.PI * clampNumber((cutInPhase - 0.85) / 0.15, 0, 1)),
    },
    { id: 'behind', ahead: -2 - mod(t * 2.5, 6), lateral: 3.7, heading: 0 },
  ];
  const length = 4.6;
  const width = 1.9;
  const inLane = (vehicle: (typeof vehicles)[number]) => {
    const halfExtent = (Math.abs(Math.cos(vehicle.heading)) * width + Math.abs(Math.sin(vehicle.heading)) * length) / 2;
    return Math.abs(vehicle.lateral) - halfExtent < 1.85;
  };
  const lead = vehicles
    .filter((vehicle) => vehicle.ahead > 0 && inLane(vehicle))
    .sort((a, b) => a.ahead - b.ahead)[0];

  return (
    <g>
      <StraightRoad top={top} laneWidth={laneWidth} lanes={3} scroll={t * 22 * scale * 0.2} highlightLane={1} />
      {lead ? (
        <g>
          <line x1={toX(length / 2)} x2={toX(lead.ahead - length / 2)} y1={top - 12} y2={top - 12} stroke={COLOR.signal} strokeWidth={1} />
          <line x1={toX(length / 2)} x2={toX(length / 2)} y1={top - 15} y2={top - 9} stroke={COLOR.signal} />
          <line x1={toX(lead.ahead - length / 2)} x2={toX(lead.ahead - length / 2)} y1={top - 15} y2={top - 9} stroke={COLOR.signal} />
          <Text x={(toX(length / 2) + toX(lead.ahead - length / 2)) / 2} y={top - 17} anchor="middle" color={COLOR.signal}>
            {`closest ahead: ${lead.ahead.toFixed(0)} m`}
          </Text>
        </g>
      ) : null}
      {vehicles.map((vehicle) => (
        <Car
          key={vehicle.id}
          x={toX(vehicle.ahead)}
          y={toY(vehicle.lateral)}
          length={length * scale}
          width={width * scale}
          heading={vehicle.heading}
          color={inLane(vehicle) ? COLOR.inLane : COLOR.traffic}
          outline={vehicle === lead ? COLOR.signal : undefined}
        />
      ))}
      <Car x={egoX} y={egoLaneCenter} length={length * scale} width={width * scale} color={COLOR.signal} />
      <Swatch x={10} y={170} color={COLOR.inLane} label="overlaps your lane" />
      <Swatch x={118} y={170} color={COLOR.traffic} label="other lanes" />
      <Swatch x={198} y={170} color={COLOR.signal} label="you" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// PID

interface PidSample {
  setpoint: number;
  position: number;
  p: number;
  i: number;
  d: number;
}

const PID_DT = 1 / 60;
const PID_CYCLE = 10;

/** One loop of a PID steering a mass with friction and a steady push to setpoint steps. */
const pidSamples: PidSample[] = (() => {
  const kp = 2;
  const ki = 1.2;
  const kd = 0.5;
  const disturbance = -0.6;
  const steps = Math.round(PID_CYCLE / PID_DT);
  let position = 0;
  let velocity = 0;
  let integral = 0;
  let previousError: number | undefined;
  const samples: PidSample[] = [];
  // The first two loops settle the integral so the recorded loop repeats seamlessly.
  for (let loop = 0; loop < 3; loop += 1) {
    for (let step = 0; step < steps; step += 1) {
      const setpoint = step < steps / 2 ? 1 : 0;
      const error = setpoint - position;
      integral += error * PID_DT;
      const derivative = previousError === undefined ? 0 : (error - previousError) / PID_DT;
      previousError = error;
      const p = kp * error;
      const i = ki * integral;
      const d = kd * derivative;
      velocity += (3 * (p + i + d) + disturbance - 1.2 * velocity) * PID_DT;
      position += velocity * PID_DT;
      if (loop === 2) samples.push({ setpoint, position, p, i, d });
    }
  }
  return samples;
})();

function pidSampleAt(time: number): PidSample {
  return pidSamples[Math.floor(mod(time, PID_CYCLE) / PID_DT) % pidSamples.length];
}

function drawPid(t: number): ReactNode {
  const left = 26;
  const right = 214;
  const top = 22;
  const bottom = 146;
  const span = 6;
  const toY = (value: number) => bottom - ((value + 0.4) / 1.8) * (bottom - top);
  const history = Array.from({ length: 181 }, (_, index) => {
    const time = t - span + (span * index) / 180;
    return { x: left + ((right - left) * index) / 180, sample: pidSampleAt(time) };
  });
  const now = history[history.length - 1].sample;
  const output = now.p + now.i + now.d;

  const barTop = 30;
  const barBottom = 140;
  const barZero = (barTop + barBottom) / 2;
  const barScale = 40;
  const bars = [
    { label: 'P', value: now.p, color: COLOR.signal },
    { label: 'I', value: now.i, color: COLOR.inLane },
    { label: 'D', value: now.d, color: COLOR.warning },
    { label: 'out', value: output, color: COLOR.foreground },
  ];

  return (
    <g>
      {[0, 1].map((value) => (
        <g key={value}>
          <line x1={left} x2={right} y1={toY(value)} y2={toY(value)} stroke={COLOR.grid} />
          <Text x={left - 5} y={toY(value) + 3} anchor="end">{value}</Text>
        </g>
      ))}
      <path d={path(history.map(({ x, sample }) => [x, toY(sample.setpoint)]))} fill="none" stroke={COLOR.muted} strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={path(history.map(({ x, sample }) => [x, toY(sample.position)]))} fill="none" stroke={COLOR.signal} strokeWidth={2} />
      <circle cx={right} cy={toY(now.position)} r={3.5} fill={COLOR.signal} />

      <line x1={232} x2={312} y1={barZero} y2={barZero} stroke={COLOR.grid} />
      {bars.map((bar, index) => {
        const x = 236 + index * 20;
        const height = clampNumber(bar.value, -1.3, 1.3) * barScale;
        return (
          <g key={bar.label}>
            <rect
              x={x}
              y={height >= 0 ? barZero - height : barZero}
              width={13}
              height={Math.max(0.8, Math.abs(height))}
              rx={1.5}
              fill={bar.color}
              opacity={bar.label === 'out' ? 0.85 : 1}
            />
            <Text x={x + 6.5} y={barBottom + 14} anchor="middle" color={bar.color}>{bar.label}</Text>
          </g>
        );
      })}

      <Swatch x={left} y={170} color={COLOR.muted} dashed label="setpoint" />
      <Swatch x={left + 68} y={170} color={COLOR.signal} label="measured" />
      <Text x={236} y={170}>terms now</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Lane reading

function noise(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function drawLaneReading(t: number): ReactNode {
  const egoX = 22;
  const longScale = 4.3;
  const latScale = 10;
  const centerY = 80;
  const offset = 1.1 * Math.sin(t * 0.6);
  const heading = 0.03 * Math.sin(t * 0.45 + 1);
  const curvature = 0.0018 * Math.sin(t * 0.3);
  const laneCenter = (ahead: number) => offset + heading * ahead + 0.5 * curvature * ahead * ahead;
  const toX = (ahead: number) => egoX + ahead * longScale;
  const toY = (lateral: number) => centerY + lateral * latScale;
  const frame = Math.floor(t / 0.2);
  const fitStart = 3;
  const fitEnd = 21;
  const sampleDistances = Array.from({ length: 22 }, (_, index) => 3 + index * 3);
  const curve = (lateralShift: number, from: number, to: number) =>
    path(Array.from({ length: 30 }, (_, index) => {
      const ahead = from + ((to - from) * index) / 29;
      return [toX(ahead), toY(laneCenter(ahead) + lateralShift)];
    }));
  const tangentLength = 26;

  return (
    <g>
      <rect x={toX(fitStart)} y={toY(-4)} width={(fitEnd - fitStart) * longScale} height={8 * latScale} fill={COLOR.signal} opacity={0.06} />
      <Text x={toX((fitStart + fitEnd) / 2)} y={toY(-4) - 4} anchor="middle" color={COLOR.signal}>fitted 3–21 m</Text>
      {[-1.85, 1.85].map((side) => (
        <g key={side}>
          <path d={curve(side, 0, 68)} fill="none" stroke={COLOR.laneLine} strokeWidth={1} />
          {sampleDistances.map((ahead, index) => (
            <circle
              key={ahead}
              cx={toX(ahead)}
              cy={toY(laneCenter(ahead) + side + (noise(frame * 53 + index + side * 11) - 0.5) * 0.5)}
              r={1.7}
              fill={COLOR.foreground}
              opacity={ahead <= fitEnd ? 0.85 : 0.35}
            />
          ))}
        </g>
      ))}
      <path d={curve(0, 0, fitEnd)} fill="none" stroke={COLOR.signal} strokeWidth={2} />
      <line
        x1={egoX}
        x2={egoX + tangentLength * longScale}
        y1={toY(offset)}
        y2={toY(offset + heading * tangentLength)}
        stroke={COLOR.warning}
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <Car x={egoX} y={toY(0)} length={26} width={1.9 * latScale} color={COLOR.signal} />
      <line x1={egoX + 17} x2={egoX + 17} y1={toY(0)} y2={toY(offset)} stroke={COLOR.foreground} strokeWidth={1.4} />
      <line x1={egoX + 14} x2={egoX + 20} y1={toY(offset)} y2={toY(offset)} stroke={COLOR.foreground} strokeWidth={1.4} />

      <Text x={10} y={150} color={COLOR.foreground}>centerOffset</Text>
      <Text x={10} y={162} color={COLOR.signal}>{`${offset >= 0 ? '+' : ''}${offset.toFixed(2)} m`}</Text>
      <Text x={112} y={150} color={COLOR.foreground}>heading</Text>
      <Text x={112} y={162} color={COLOR.warning}>{`${((heading * 180) / Math.PI).toFixed(1)}°`}</Text>
      <Text x={196} y={150} color={COLOR.foreground}>curvature</Text>
      <Text x={196} y={162}>{`${curvature >= 0 ? '+' : ''}${curvature.toFixed(4)} 1/m`}</Text>
      <Text x={10} y={174}>Dots are noisy lane-line samples; the teal line is the fitted lane center.</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Speed feedforward

const fullMotorAccel = (speed: number) => 4.5 * (1 - Math.pow(Math.min(speed / 58, 1), 1.65));
const dragAccel = (speed: number) => 0.00085 * speed * speed + 0.012 * speed;
const feedforwardMotor = (speed: number, wind = 0) => clampNumber((dragAccel(speed) + wind) / Math.max(fullMotorAccel(speed), 0.01), 0, 1);

function drawSpeedFeedforward(t: number): ReactNode {
  const left = 34;
  const right = 304;
  const top = 18;
  const bottom = 140;
  const maxSpeed = 45;
  const wind = 0.3;
  const toX = (speed: number) => left + (speed / maxSpeed) * (right - left);
  const toY = (motor: number) => bottom - motor * (bottom - top);
  const curve = (windAccel: number) =>
    path(Array.from({ length: 91 }, (_, index) => {
      const speed = (index / 90) * maxSpeed;
      return [toX(speed), toY(feedforwardMotor(speed, windAccel))];
    }));
  const target = 27 + 11 * Math.sin(t * 0.55);
  const estimate = feedforwardMotor(target);
  const needed = feedforwardMotor(target, wind);

  return (
    <g>
      {[0, 0.5, 1].map((motor) => (
        <g key={motor}>
          <line x1={left} x2={right} y1={toY(motor)} y2={toY(motor)} stroke={COLOR.grid} />
          <Text x={left - 5} y={toY(motor) + 3} anchor="end">{motor}</Text>
        </g>
      ))}
      {[0, 15, 30, 45].map((speed) => (
        <Text key={speed} x={toX(speed)} y={bottom + 12} anchor={speed === maxSpeed ? 'end' : 'middle'}>
          {speed === maxSpeed ? `${speed} m/s` : speed}
        </Text>
      ))}
      <Text x={left - 26} y={top - 6}>motor</Text>

      <path d={curve(wind)} fill="none" stroke={COLOR.muted} strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={curve(0)} fill="none" stroke={COLOR.signal} strokeWidth={2} />

      <line x1={toX(target)} x2={toX(target)} y1={bottom} y2={toY(needed)} stroke={COLOR.foreground} strokeWidth={0.6} strokeDasharray="2 2" opacity={0.6} />
      <line x1={toX(target) + 6} x2={toX(target) + 6} y1={toY(estimate)} y2={toY(needed)} stroke={COLOR.warning} strokeWidth={1.4} />
      <line x1={toX(target) + 3} x2={toX(target) + 9} y1={toY(estimate)} y2={toY(estimate)} stroke={COLOR.warning} />
      <line x1={toX(target) + 3} x2={toX(target) + 9} y1={toY(needed)} y2={toY(needed)} stroke={COLOR.warning} />
      <Text
        x={target > 26 ? toX(target) - 6 : toX(target) + 13}
        y={(toY(estimate) + toY(needed)) / 2 + 3}
        anchor={target > 26 ? 'end' : 'start'}
        color={COLOR.warning}
      >
        PID makes up the wind
      </Text>
      <circle cx={toX(target)} cy={toY(needed)} r={2.5} fill={COLOR.muted} />
      <circle cx={toX(target)} cy={toY(estimate)} r={3.5} fill={COLOR.signal} />

      <Swatch x={left} y={170} color={COLOR.signal} label={`speedFeedforward(${target.toFixed(0)}) = ${estimate.toFixed(2)}`} />
      <Swatch x={left + 150} y={170} color={COLOR.muted} dashed label="needed into a headwind" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Steering feedforward

function drawSteeringFeedforward(t: number): ReactNode {
  const egoX = 20;
  const longScale = 3.6;
  const latScale = 4.2;
  const centerY = 74;
  const speed = 25;
  const curvature = 0.003 * Math.sin(t * 0.35);
  const laneCenter = (ahead: number) => 0.5 * curvature * ahead * ahead;
  const toX = (ahead: number) => egoX + ahead * longScale;
  const toY = (lateral: number) => centerY + lateral * latScale;
  const feedforward = clampNumber((curvature * speed) / (0.68 * clampNumber(speed / 22, 0.08, 1)), -1, 1);
  const wheelAngle = feedforward * 160;
  const wheelX = 290;
  const wheelY = 152;
  const road = (lateralShift: number) =>
    path(Array.from({ length: 30 }, (_, index) => {
      const ahead = (index / 29) * 82;
      return [toX(ahead), toY(laneCenter(ahead) + lateralShift)];
    }));

  return (
    <g>
      <path d={road(0)} fill="none" stroke={COLOR.asphalt} strokeWidth={3.7 * latScale * 2.2} />
      <path d={road(-1.85 * 1.1)} fill="none" stroke={COLOR.laneLine} strokeWidth={1} />
      <path d={road(1.85 * 1.1)} fill="none" stroke={COLOR.laneLine} strokeWidth={1} />
      <path d={road(0)} fill="none" stroke={COLOR.signal} strokeWidth={1.6} strokeDasharray="5 4" />
      <Car x={egoX} y={toY(0)} length={4.6 * longScale} width={1.9 * latScale * 1.2} color={COLOR.signal} />

      <g transform={`translate(${wheelX} ${wheelY}) rotate(${wheelAngle.toFixed(1)})`}>
        <circle r={14} fill="none" stroke={COLOR.foreground} strokeWidth={2.5} />
        <line x1={-14} x2={14} y1={0} y2={0} stroke={COLOR.foreground} strokeWidth={2} />
        <line x1={0} x2={0} y1={0} y2={14} stroke={COLOR.foreground} strokeWidth={2} />
        <circle cy={-14} r={2.5} fill={COLOR.warning} />
      </g>
      <Text x={10} y={150} color={COLOR.foreground}>lane.curvature</Text>
      <Text x={10} y={162}>{`${curvature >= 0 ? '+' : ''}${curvature.toFixed(4)} 1/m`}</Text>
      <Text x={104} y={150} color={COLOR.foreground}>steeringFeedforward</Text>
      <Text x={104} y={162} color={COLOR.warning}>{`${feedforward >= 0 ? '+' : ''}${feedforward.toFixed(2)} at ${speed} m/s`}</Text>
      <Text x={10} y={174}>The car follows the dashed path from feedforward alone.</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Lateral velocity steering

interface LateralSample {
  offset: number;
  target: number;
  actual: number;
}

const LATERAL_DT = 1 / 60;
const LATERAL_CYCLE = 5;

/** The car starts off-center, alternating sides each loop, and a P loop sets the sideways speed. */
const lateralSamples: LateralSample[] = (() => {
  const samples: LateralSample[] = [];
  const steps = Math.round(LATERAL_CYCLE / LATERAL_DT);
  for (const side of [1, -1]) {
    let offset = 1.3 * side;
    let actual = 0;
    for (let step = 0; step < steps; step += 1) {
      const target = clampNumber(-1 * offset, -1.5, 1.5);
      actual += (target - actual) * (LATERAL_DT / 0.35);
      offset += actual * LATERAL_DT;
      samples.push({ offset, target, actual });
    }
  }
  return samples;
})();

function drawLateralVelocity(t: number): ReactNode {
  const sample = lateralSamples[Math.floor(mod(t, LATERAL_CYCLE * 2) / LATERAL_DT) % lateralSamples.length];
  const scale = 12;
  const laneWidth = 3.7 * scale;
  const top = 40;
  const laneCenter = top + laneWidth * 1.5;
  const egoX = 90;
  const egoY = laneCenter + sample.offset * scale;
  const arrowScale = 34;
  const arrow = (velocity: number, color: string, x: number) => {
    const end = egoY + velocity * arrowScale;
    const direction = Math.sign(velocity) || 1;
    return (
      <g>
        <line x1={x} x2={x} y1={egoY} y2={end} stroke={color} strokeWidth={2} />
        {Math.abs(velocity) > 0.05 ? (
          <path d={`M${x - 4},${end - direction * 5} L${x},${end} L${x + 4},${end - direction * 5}`} fill="none" stroke={color} strokeWidth={2} />
        ) : null}
      </g>
    );
  };

  return (
    <g>
      <StraightRoad top={top} laneWidth={laneWidth} lanes={3} scroll={t * 22 * 3} />
      <line x1={0} x2={W} y1={laneCenter} y2={laneCenter} stroke={COLOR.warning} strokeWidth={1} strokeDasharray="3 4" opacity={0.7} />
      <Car x={egoX} y={egoY} length={4.6 * scale} width={1.9 * scale} heading={Math.atan2(sample.actual, 25)} color={COLOR.signal} />
      {arrow(sample.target, COLOR.warning, egoX + 44)}
      {arrow(sample.actual, COLOR.signal, egoX + 56)}

      <Text x={10} y={150} color={COLOR.foreground}>centerOffset</Text>
      <Text x={10} y={162}>{`${(-sample.offset >= 0 ? '+' : '')}${(-sample.offset).toFixed(2)} m`}</Text>
      <Text x={104} y={150} color={COLOR.foreground}>target sideways</Text>
      <Text x={104} y={162} color={COLOR.warning}>{`${sample.target >= 0 ? '+' : ''}${sample.target.toFixed(2)} m/s`}</Text>
      <Text x={212} y={150} color={COLOR.foreground}>actual sideways</Text>
      <Text x={212} y={162} color={COLOR.signal}>{`${sample.actual >= 0 ? '+' : ''}${sample.actual.toFixed(2)} m/s`}</Text>
      <Text x={10} y={174}>You pick the sideways speed; the helper steers to hold it.</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Adaptive cruise

interface CruiseSample {
  gap: number;
  egoSpeed: number;
  leadSpeed: number;
  targetSpeed: number;
  targetGap: number;
}

const CRUISE_DT = 1 / 30;
const CRUISE_CYCLE = 14;
const FREE_ROAD_SPEED = 29;

const cruiseSamples: CruiseSample[] = (() => {
  const steps = Math.round(CRUISE_CYCLE / CRUISE_DT);
  let egoSpeed = 24;
  let gap = 40;
  const samples: CruiseSample[] = [];
  for (let loop = 0; loop < 3; loop += 1) {
    for (let step = 0; step < steps; step += 1) {
      const time = step * CRUISE_DT;
      const leadSpeed = 24 + 7 * Math.cos((2 * Math.PI * time) / CRUISE_CYCLE);
      const targetGap = 10 + egoSpeed * 1.25;
      const gapError = gap - targetGap;
      const targetSpeed = gapError > 18 ? FREE_ROAD_SPEED : Math.max(4, Math.min(FREE_ROAD_SPEED, leadSpeed + gapError * 0.35));
      egoSpeed += clampNumber((targetSpeed - egoSpeed) * 0.9, -4, 2.5) * CRUISE_DT;
      gap += (leadSpeed - egoSpeed) * CRUISE_DT;
      if (loop === 2) samples.push({ gap, egoSpeed, leadSpeed, targetSpeed, targetGap });
    }
  }
  return samples;
})();

function drawAdaptiveCruise(t: number): ReactNode {
  const sample = cruiseSamples[Math.floor(mod(t, CRUISE_CYCLE) / CRUISE_DT) % cruiseSamples.length];
  const scale = 3.9;
  const egoX = 26;
  const laneTop = 62;
  const laneWidth = 3.7 * scale * 1.6;
  const laneCenter = laneTop + laneWidth / 2;
  const length = 4.6 * scale;
  const toX = (ahead: number) => egoX + ahead * scale;
  const following = sample.targetSpeed < FREE_ROAD_SPEED - 0.05;
  const distance = t * 26;

  return (
    <g>
      <StraightRoad top={laneTop} laneWidth={laneWidth} lanes={1} scroll={distance * scale} />
      {Array.from({ length: 9 }, (_, index) => (
        <line
          key={index}
          x1={mod(index * 40 - distance * scale, 360) - 20}
          x2={mod(index * 40 - distance * scale, 360) - 8}
          y1={laneCenter}
          y2={laneCenter}
          stroke={COLOR.laneLine}
          strokeWidth={0.8}
          opacity={0.4}
        />
      ))}
      <rect
        x={toX(length / scale / 2)}
        y={laneTop + 2}
        width={Math.max(0, (sample.targetGap - 4.6) * scale)}
        height={laneWidth - 4}
        fill={COLOR.warning}
        opacity={0.1}
      />
      <line x1={toX(sample.targetGap - 2.3)} x2={toX(sample.targetGap - 2.3)} y1={laneTop - 4} y2={laneTop + laneWidth + 4} stroke={COLOR.warning} strokeDasharray="3 2" />
      <Text x={toX(sample.targetGap - 2.3)} y={laneTop + laneWidth + 15} anchor="middle" color={COLOR.warning}>
        {`target gap ${sample.targetGap.toFixed(0)} m`}
      </Text>
      <line x1={toX(2.3)} x2={toX(sample.gap - 2.3)} y1={laneTop - 12} y2={laneTop - 12} stroke={COLOR.foreground} strokeWidth={0.8} />
      <Text x={toX(2.3)} y={laneTop - 17}>{`gap ${sample.gap.toFixed(0)} m`}</Text>
      <Car x={toX(sample.gap)} y={laneCenter} length={length} width={1.9 * scale * 1.6} color={COLOR.inLane} />
      <Car x={egoX} y={laneCenter} length={length} width={1.9 * scale * 1.6} color={COLOR.signal} />

      <Text x={10} y={150} color={COLOR.foreground}>lead speed</Text>
      <Text x={10} y={162} color={COLOR.inLane}>{`${sample.leadSpeed.toFixed(1)} m/s`}</Text>
      <Text x={96} y={150} color={COLOR.foreground}>your target speed</Text>
      <Text x={96} y={162} color={COLOR.signal}>{`${sample.targetSpeed.toFixed(1)} m/s`}</Text>
      <Text x={210} y={150} color={COLOR.foreground}>mode</Text>
      <Text x={210} y={162} color={following ? COLOR.warning : COLOR.muted}>{following ? 'following' : `free road, ${FREE_ROAD_SPEED} m/s`}</Text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Fastest lane

const FASTEST_CYCLE = 9;

function drawFastestLane(t: number): ReactNode {
  const time = mod(t, FASTEST_CYCLE);
  const scale = 7;
  const laneWidth = 3.7 * scale;
  const top = 46;
  const egoX = 50;
  const laneSpeeds = [29, 19, 23];
  const egoSpeedAt = (time: number) => 19 + 10 * smoothstep((time - 1.8) / 3.5);
  // Distance ego has travelled since the loop started, by summing small steps.
  const steps = 60;
  let egoDistance = 0;
  for (let index = 0; index < steps; index += 1) egoDistance += egoSpeedAt(((index + 0.5) / steps) * time) * (time / steps);
  const change = smoothstep((time - 1.8) / 2.2);
  const egoLane = 1 - change;
  const toY = (lane: number) => top + (lane + 0.5) * laneWidth;
  const ahead = (start: number, laneSpeed: number) => start + laneSpeed * time - egoDistance;
  const fade = Math.min(1, time / 0.4, (FASTEST_CYCLE - time) / 0.4);
  const traffic = [
    { lane: 1, ahead: ahead(13, laneSpeeds[1]) },
    { lane: 1, ahead: ahead(32, laneSpeeds[1]) },
    { lane: 2, ahead: ahead(4, laneSpeeds[2]) },
    { lane: 2, ahead: ahead(26, laneSpeeds[2]) },
    { lane: 0, ahead: ahead(48, laneSpeeds[0]) },
  ];
  const choosing = time > 1.2 && time < 4;

  return (
    <g>
      <StraightRoad top={top} laneWidth={laneWidth} lanes={3} scroll={egoDistance * scale} highlightLane={choosing || time >= 4 ? 0 : undefined} />
      <g opacity={fade}>
        {traffic.map((vehicle, index) => (
          <Car key={index} x={egoX + vehicle.ahead * scale} y={toY(vehicle.lane)} length={4.6 * scale} width={1.9 * scale} color={COLOR.traffic} />
        ))}
        <Car
          x={egoX}
          y={toY(egoLane)}
          length={4.6 * scale}
          width={1.9 * scale}
          heading={-0.25 * Math.sin(Math.PI * change)}
          color={COLOR.signal}
        />
      </g>
      <rect x={W - 58} y={top} width={58} height={laneWidth * 3} fill="hsl(200 30% 4%)" opacity={0.85} />
      {laneSpeeds.map((speed, lane) => (
        <Text key={lane} x={W - 8} y={toY(lane) + 3} anchor="end" color={lane === 0 ? COLOR.signal : COLOR.muted}>
          {`${speed} m/s`}
        </Text>
      ))}
      <Text x={10} y={top - 12} color={COLOR.foreground}>
        {time < 1.2 ? 'Stuck behind 19 m/s traffic' : time < 4 ? 'Left lane is 10 m/s faster and has room' : 'Settled in the faster lane'}
      </Text>
      <Text x={10} y={160}>Lane speed is the speed of the closest car ahead in that lane.</Text>
      <Text x={10} y={172}>It switches only for a gain over minSpeedGain, with room to merge.</Text>
    </g>
  );
}

const visuals: Record<string, VisualDefinition> = {
  clamp: {
    label: 'A wavy signal passes through clamp; the parts beyond plus or minus one are flattened at the limit.',
    caption: 'Anything outside the range is held at the nearest limit. Motor and steering must stay within −1 to +1.',
    stillAt: 1.1,
    draw: drawClamp,
  },
  'vehicle-filtering': {
    label: 'Top-down road. Cars overlapping your lane are highlighted and the closest one ahead is outlined with its distance.',
    caption: 'A car counts as in your lane when any part of it overlaps the lane, so a car cutting in counts before it is centered.',
    stillAt: 4.2,
    draw: drawVehicleFiltering,
  },
  'pid-controller': {
    label: 'A PID controller follows a setpoint that steps between 0 and 1, with bars showing the P, I and D terms.',
    caption: 'P pushes in proportion to the error, D brakes fast changes, and I builds up until it cancels the steady push the plant is fighting.',
    stillAt: 0.9,
    draw: drawPid,
  },
  'analyze-lane': {
    label: 'Noisy lane-line samples with a fitted lane center, and the offset, heading and curvature read at your car.',
    caption: 'Steer on centerOffset plus a little heading. Pass curvature to steeringFeedforward to start turning before the error builds up.',
    stillAt: 3,
    draw: drawLaneReading,
  },
  'speed-feedforward': {
    label: 'Chart of the motor needed to hold each speed, with and without a headwind.',
    caption: 'Feedforward gives the motor needed to hold a speed against drag. Wind changes from run to run, so PID feedback covers what the model misses.',
    stillAt: 1.2,
    draw: drawSpeedFeedforward,
  },
  'steering-feedforward': {
    label: 'A road bending left and right, with a steering wheel turning to match the curve.',
    caption: 'Following a curve needs turning at curvature × speed. Feedforward steers for the curve; the lane PID only fixes the drift.',
    stillAt: 4.5,
    draw: drawSteeringFeedforward,
  },
  'lateral-velocity': {
    label: 'A car off the lane center slides back toward it, with arrows for the target and actual sideways speed.',
    caption: 'Your outer loop turns distance from the center into a target sideways speed. This helper is the inner loop that steers to hold that speed.',
    stillAt: 0.8,
    draw: drawLateralVelocity,
  },
  'adaptive-cruise': {
    label: 'Your car following a lead car that speeds up and slows down, with the target gap shaded.',
    caption: 'The target gap grows with your speed. Inside it, your target speed drops below the lead\'s until the gap opens back up.',
    stillAt: 6,
    draw: drawAdaptiveCruise,
  },
  'fastest-lane': {
    label: 'Your car is stuck behind slow traffic and changes to a faster adjacent lane.',
    caption: 'Pass the lane it returns into analyzeLaneRegression and adaptiveCruiseTargetSpeed so steering and speed follow the change.',
    stillAt: 3,
    draw: drawFastestLane,
  },
};
