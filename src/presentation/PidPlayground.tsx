import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DeckButton, Toggle } from './controls';
import { bubblegum, cherry, ink, mint, panel, sky, sun } from './theme';

const DT = 1 / 120;
const HISTORY_SECONDS = 8;
const STEP_PERIOD_SECONDS = 6;
const OUTPUT_LIMIT = 3;
/** Same default as the toolbox createPidController. */
const DERIVATIVE_SMOOTHING = 0.05;
const WIND_PUSH = -1.8;
const NOISE = 0.035;

interface Gains {
  kp: number;
  ki: number;
  kd: number;
}

interface Sample {
  time: number;
  setpoint: number;
  position: number;
}

const PRESETS: { label: string; gains: Gains }[] = [
  { label: 'P only', gains: { kp: 2, ki: 0, kd: 0 } },
  { label: 'Too much P', gains: { kp: 9, ki: 0, kd: 0 } },
  { label: 'P + D', gains: { kp: 4, ki: 0, kd: 1.2 } },
  { label: 'PID', gains: { kp: 4, ki: 1.5, kd: 1.2 } },
];

/**
 * A car on a track tries to stop at a flag. The PID pushes it (like the motor);
 * the car has friction, and optionally wind pushes it back.
 */
export function PidPlayground() {
  const [gains, setGains] = useState<Gains>(PRESETS[0].gains);
  const [wind, setWind] = useState(false);
  const [noise, setNoise] = useState(false);
  const [autoStep, setAutoStep] = useState(true);
  const [, setFrame] = useState(0);
  const settingsRef = useRef({ gains, wind, noise, autoStep });
  settingsRef.current = { gains, wind, noise, autoStep };

  const state = useRef({
    time: 0,
    position: 0,
    velocity: 0,
    setpoint: 1,
    nextStepAt: STEP_PERIOD_SECONDS,
    integral: 0,
    previousError: undefined as number | undefined,
    derivative: 0,
    terms: { p: 0, i: 0, d: 0, output: 0 },
    history: [] as Sample[],
  });

  const reset = () => {
    Object.assign(state.current, {
      time: 0,
      position: 0,
      velocity: 0,
      setpoint: 1,
      nextStepAt: STEP_PERIOD_SECONDS,
      integral: 0,
      previousError: undefined,
      derivative: 0,
      terms: { p: 0, i: 0, d: 0, output: 0 },
      history: [],
    });
  };

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let pending = 0;
    const loop = (now: number) => {
      pending += Math.min(0.1, (now - previous) / 1000);
      previous = now;
      const sim = state.current;
      const { gains: { kp, ki, kd }, wind: windOn, noise: noiseOn, autoStep: auto } = settingsRef.current;
      while (pending >= DT) {
        pending -= DT;
        sim.time += DT;
        if (auto && sim.time >= sim.nextStepAt) {
          sim.setpoint = sim.setpoint > 0.5 ? 0 : 1;
          sim.nextStepAt = sim.time + STEP_PERIOD_SECONDS;
        }
        const measured = sim.position + (noiseOn ? gaussian() * NOISE : 0);
        const error = sim.setpoint - measured;
        sim.integral += error * DT;
        const rawDerivative = sim.previousError === undefined ? 0 : (error - sim.previousError) / DT;
        sim.derivative = sim.previousError === undefined
          ? rawDerivative
          : sim.derivative + (rawDerivative - sim.derivative) * (DT / (DERIVATIVE_SMOOTHING + DT));
        sim.previousError = error;
        const p = kp * error;
        const i = ki * sim.integral;
        const d = kd * sim.derivative;
        const output = Math.max(-OUTPUT_LIMIT, Math.min(OUTPUT_LIMIT, p + i + d));
        sim.terms = { p, i, d, output };
        sim.velocity += (3 * output - 1.2 * sim.velocity + (windOn ? WIND_PUSH : 0)) * DT;
        sim.position += sim.velocity * DT;
      }
      sim.history.push({ time: sim.time, setpoint: sim.setpoint, position: sim.position });
      while (sim.history.length > 0 && sim.history[0].time < sim.time - HISTORY_SECONDS) sim.history.shift();
      setFrame((value) => value + 1);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const sim = state.current;
  const moveFlag = (fraction: number) => {
    sim.setpoint = trackValue(fraction);
    sim.nextStepAt = sim.time + STEP_PERIOD_SECONDS;
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_22rem] gap-5">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
        <Track position={sim.position} setpoint={sim.setpoint} velocity={sim.velocity} wind={wind} onClick={moveFlag} />
        <Chart history={sim.history} now={sim.time} />
        <Terms terms={sim.terms} />
      </div>

      <div className={`flex min-h-0 flex-col gap-4 overflow-auto p-5 ${panel}`}>
        <GainSlider label="P" name="kp" color={sky} max={10} step={0.1} value={gains.kp} onChange={(kp) => setGains({ ...gains, kp })}>
          push harder the further you are
        </GainSlider>
        <GainSlider label="I" name="ki" color={sun} max={5} step={0.1} value={gains.ki} onChange={(ki) => setGains({ ...gains, ki })}>
          push harder the longer you've been off
        </GainSlider>
        <GainSlider label="D" name="kd" color={bubblegum} max={3} step={0.05} value={gains.kd} onChange={(kd) => setGains({ ...gains, kd })}>
          ease off when closing in fast
        </GainSlider>

        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((preset) => (
            <DeckButton key={preset.label} onClick={() => setGains(preset.gains)}>
              {preset.label}
            </DeckButton>
          ))}
        </div>

        <div className="grid gap-2 border-t-[3px] border-[#1d1b2e] pt-3 text-lg font-black">
          <Toggle checked={wind} onChange={setWind}>
            Headwind
          </Toggle>
          <Toggle checked={noise} onChange={setNoise}>
            Noisy sensor
          </Toggle>
          <Toggle checked={autoStep} onChange={setAutoStep}>
            Move the flag every {STEP_PERIOD_SECONDS} s
          </Toggle>
        </div>
        <DeckButton onClick={reset}>Restart</DeckButton>
      </div>
    </div>
  );
}

/** Track positions run from -0.8 to 1.8 so overshoot past either flag stays visible. */
const TRACK_MIN = -0.8;
const TRACK_MAX = 1.8;
const trackFraction = (value: number) => (value - TRACK_MIN) / (TRACK_MAX - TRACK_MIN);
const trackValue = (fraction: number) => TRACK_MIN + fraction * (TRACK_MAX - TRACK_MIN);

function Track({
  position,
  setpoint,
  velocity,
  wind,
  onClick,
}: {
  position: number;
  setpoint: number;
  velocity: number;
  wind: boolean;
  onClick: (fraction: number) => void;
}) {
  const carLeft = `${Math.max(0, Math.min(1, trackFraction(position))) * 100}%`;
  const flagLeft = `${Math.max(0, Math.min(1, trackFraction(setpoint))) * 100}%`;
  const tilt = Math.max(-8, Math.min(8, velocity * 6));
  return (
    <div
      className={`relative h-28 cursor-crosshair overflow-hidden ${panel}`}
      style={{ background: '#565d6e' }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onClick((event.clientX - bounds.left) / bounds.width);
      }}
      title="Click to move the flag"
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2" style={{ background: 'repeating-linear-gradient(90deg, #fff6d5 0 28px, transparent 28px 56px)' }} />
      {wind ? (
        <div className="absolute right-4 top-2 animate-pulse text-lg font-black text-white">💨 wind pushing back</div>
      ) : null}
      <div className="absolute bottom-0 top-0 w-1 -translate-x-1/2" style={{ left: flagLeft, background: sun }}>
        <div className="absolute left-1 top-1 text-3xl">🚩</div>
      </div>
      <div
        className="absolute top-1/2 h-12 w-24 -translate-x-1/2 -translate-y-1/2 rounded-xl border-[3px] border-[#1d1b2e]"
        style={{ left: carLeft, background: cherry, transform: `translate(-50%, -50%) rotate(${tilt}deg)` }}
      >
        <div className="absolute right-2 top-1.5 h-6 w-5 rounded-md border-2 border-[#1d1b2e] bg-[#c9e8ff]" />
      </div>
    </div>
  );
}

function Chart({ history, now }: { history: Sample[]; now: number }) {
  const width = 1000;
  const height = 360;
  const x = (time: number) => ((time - (now - HISTORY_SECONDS)) / HISTORY_SECONDS) * width;
  const y = (value: number) => height - ((value - TRACK_MIN) / (TRACK_MAX - TRACK_MIN)) * height;
  const line = (pick: (sample: Sample) => number) =>
    history.map((sample, index) => `${index === 0 ? 'M' : 'L'}${x(sample.time).toFixed(1)},${y(pick(sample)).toFixed(1)}`).join('');
  const last = history[history.length - 1];
  return (
    <div className={`relative min-h-0 p-3 ${panel}`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-full w-full">
        {[0, 1].map((value) => (
          <line key={value} x1={0} x2={width} y1={y(value)} y2={y(value)} stroke={ink} strokeOpacity={0.12} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={line((sample) => sample.setpoint)} fill="none" stroke={ink} strokeWidth={3} strokeDasharray="10 8" vectorEffect="non-scaling-stroke" />
        <path d={line((sample) => sample.position)} fill="none" stroke={cherry} strokeWidth={5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {last ? (
        <div
          className="pointer-events-none absolute right-3 h-4 w-4 -translate-y-1/2 translate-x-1/2 rounded-full border-[3px] border-[#1d1b2e]"
          style={{ top: `calc(0.75rem + (100% - 1.5rem) * ${1 - trackFraction(last.position)})`, background: cherry }}
        />
      ) : null}
      <div className="absolute left-5 top-3 flex gap-5 text-base font-black">
        <span className="flex items-center gap-2">
          <span className="inline-block h-1 w-8 border-t-[3px] border-dashed border-[#1d1b2e]" /> where the flag is
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-8 rounded" style={{ background: cherry }} /> where the car is
        </span>
      </div>
    </div>
  );
}

function Terms({ terms }: { terms: { p: number; i: number; d: number; output: number } }) {
  const rows: { label: string; value: number; color: string }[] = [
    { label: 'P', value: terms.p, color: sky },
    { label: 'I', value: terms.i, color: sun },
    { label: 'D', value: terms.d, color: bubblegum },
    { label: 'Push', value: terms.output, color: mint },
  ];
  return (
    <div className={`grid grid-cols-4 gap-4 px-5 py-3 ${panel}`}>
      {rows.map((row) => {
        const fraction = Math.max(-1, Math.min(1, row.value / OUTPUT_LIMIT));
        return (
          <div key={row.label}>
            <div className="flex items-baseline justify-between font-black">
              <span className="text-xl">{row.label}</span>
              <span className="text-xl tabular-nums">{row.value >= 0 ? '+' : '−'}{Math.abs(row.value).toFixed(2)}</span>
            </div>
            <div className="relative mt-1 h-4 overflow-hidden rounded-full border-[3px] border-[#1d1b2e] bg-[#f3f1ea]">
              <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-[#1d1b2e]/40" />
              <div
                className="absolute inset-y-0"
                style={{
                  background: row.color,
                  left: fraction >= 0 ? '50%' : `${50 + fraction * 50}%`,
                  width: `${Math.abs(fraction) * 50}%`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GainSlider({
  label,
  name,
  color,
  max,
  step,
  value,
  onChange,
  children,
}: {
  label: string;
  name: string;
  color: string;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="flex items-baseline gap-2">
          <span className="rounded-lg border-[3px] border-[#1d1b2e] px-2 text-2xl font-black" style={{ background: color }}>
            {label}
          </span>
          <span className="font-mono text-lg font-bold opacity-60">{name}</span>
        </span>
        <span className="text-3xl font-black tabular-nums">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full"
        style={{ accentColor: color }}
      />
      <span className="block text-sm font-bold opacity-70">{children}</span>
    </label>
  );
}

function gaussian(): number {
  const u = Math.max(Number.EPSILON, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}
