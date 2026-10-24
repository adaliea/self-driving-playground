import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { bubblegum, cherry, ink, panel, sky, sun } from './theme';

export type CheatSheetVariant = 'distance' | 'steering';

const QUESTIONS: Record<CheatSheetVariant, string> = {
  distance: 'Should the following distance always be 30 m? When you drive, do you keep the same gap at every speed, or does it change?',
  steering: 'Watch the curves. Where does your car drift, and does the PID react before the drift or after it?',
};

/** The cheat sheet slide: a tuning recipe, how to add the PID, and where its graphs live. */
export function CheatSheet({ variant = 'distance' }: { variant?: CheatSheetVariant }) {
  const script = variant === 'steering' ? STEERING_SCRIPT : DISTANCE_SCRIPT;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,0.85fr)_minmax(0,1.5fr)] gap-5">
      <TuningRecipe question={QUESTIONS[variant]} />
      <div className="grid min-h-0 grid-rows-[minmax(0,1.25fr)_minmax(0,1fr)] gap-5">
        <Card title="Adding the PID">
          <FitBox width={ADD_WIDTH} height={ADD_HEIGHT}>
            <AddPidAnimation key={variant} script={script} />
          </FitBox>
        </Card>
        <Card title="Watching it work">
          <FitBox width={GUIDE_WIDTH} height={GUIDE_HEIGHT}>
            <TelemetryGuide pidName={script.pidName} />
          </FitBox>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
      <div className="border-b-[3px] border-[#1d1b2e] px-4 py-1.5 text-xl font-black" style={{ background: sun }}>
        {title}
      </div>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tuning recipe

const SYMPTOMS: { see: string; try: ReactNode }[] = [
  { see: 'Bounces back and forth', try: <>less <Term color={sky}>P</Term> or more <Term color={bubblegum}>D</Term></> },
  { see: 'Slow to catch up', try: <>more <Term color={sky}>P</Term></> },
  { see: 'Settles off target', try: <>a little <Term color={sun}>I</Term></> },
  { see: 'Twitchy, jittery output', try: <>less <Term color={bubblegum}>D</Term></> },
  { see: 'Big slow swings after a long wait', try: <>less <Term color={sun}>I</Term></> },
];

function TuningRecipe({ question }: { question: string }) {
  return (
    <div className={`flex min-h-0 flex-col gap-4 overflow-auto p-5 ${panel}`}>
      <h2 className="text-3xl font-black">Tune in this order</h2>
      <ol className="grid gap-3">
        <RecipeStep color={sky} label="P" title="P first.">
          Start with ki and kd at 0. Raise kp until the car reacts quickly. A little bouncing is fine.
        </RecipeStep>
        <RecipeStep color={bubblegum} label="D" title="Then D.">
          Raise kd until the bouncing calms down.
        </RecipeStep>
        <RecipeStep color={sun} label="I" title="Then a little I.">
          If it settles off target, add ki slowly.
        </RecipeStep>
      </ol>
      <div className="mt-1 border-t-[3px] border-[#1d1b2e] pt-4">
        <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-4 gap-y-3 text-xl font-bold">
          <div className="text-base font-black opacity-60">If you see…</div>
          <div className="text-base font-black opacity-60">try…</div>
          {SYMPTOMS.map((symptom) => (
            <div key={symptom.see} className="contents">
              <div>{symptom.see}</div>
              <div className="font-black">{symptom.try}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border-[3px] border-[#1d1b2e] px-4 py-3" style={{ background: sun }}>
        <div className="text-xl font-black">🤔 Think about it</div>
        <p className="mt-1 text-lg font-bold leading-snug">{question}</p>
      </div>
      <p className="mt-auto text-lg font-bold opacity-70">
        Change one gain at a time, then press Reset so every try starts the same way.
      </p>
    </div>
  );
}

function RecipeStep({ color, label, title, children }: { color: string; label: string; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-[3px] border-[#1d1b2e] text-2xl font-black"
        style={{ background: color }}
      >
        {label}
      </span>
      <div className="text-xl font-bold leading-snug">
        <span className="font-black">{title}</span> {children}
      </div>
    </li>
  );
}

function Term({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="rounded-md border-2 border-[#1d1b2e] px-1.5" style={{ background: color }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers

/** Seconds since mount, for looping animations. Frozen at `stillAt` when motion is reduced. */
function useClock(stillAt: number): number {
  const [time, setTime] = useState(stillAt);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setTime(Math.max(0, (now - start) / 1000));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return time;
}

/** Lays children out at a fixed design size and scales them to fit the available space. */
function FitBox({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setScale(Math.min(element.clientWidth / width, element.clientHeight / height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);
  return (
    <div ref={ref} className="relative h-full w-full">
      <div
        className="absolute left-1/2 top-1/2"
        style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  );
}

const between = (time: number, start: number, end: number) => Math.max(0, Math.min(1, (time - start) / (end - start)));
const ease = (x: number) => x * x * (3 - 2 * x);

/** The playground's dark editor colors. */
const editor = {
  background: '#070b0d',
  chrome: '#0e1416',
  border: '#253033',
  text: '#dde5e6',
  muted: '#6b7c80',
  keyword: '#89a9ff',
  number: '#f7c86d',
  signal: '#6df7d1',
  selection: '#1e3a5a',
};

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\/\/.*$|\b(?:const|let|export|function|if|return)\b|\b\d+(?:\.\d+)?\b|\bdistancePid\w*)/);
  return (
    <>
      {parts.map((part, index) => {
        const color = part.startsWith('//')
          ? editor.muted
          : /^(const|let|export|function|if|return)$/.test(part)
            ? editor.keyword
            : /^\d/.test(part)
              ? editor.number
              : part.startsWith('distancePid')
                ? editor.signal
                : editor.text;
        return (
          <span key={index} style={{ color }}>
            {part}
          </span>
        );
      })}
    </>
  );
}

/** Cartoon mouse pointer; `pressed` squashes it briefly for a click. */
function Pointer({ x, y, pressed }: { x: number; y: number; pressed: boolean }) {
  return (
    <svg
      width={30}
      height={36}
      viewBox="0 0 30 36"
      className="pointer-events-none absolute z-30"
      style={{ left: x, top: y, transform: `scale(${pressed ? 0.82 : 1})`, transformOrigin: '4px 4px', transition: 'transform 80ms' }}
    >
      <path d="M4 3 L4 29 L11 22 L16 33 L21 31 L16 20 L26 20 Z" fill="white" stroke={ink} strokeWidth={2.5} strokeLinejoin="round" />
    </svg>
  );
}

function Ripple({ x, y, age }: { x: number; y: number; age: number }) {
  if (age < 0 || age > 0.45) return null;
  const size = 10 + age * 90;
  return (
    <span
      className="pointer-events-none absolute z-20 rounded-full border-[3px]"
      style={{ left: x - size / 2, top: y - size / 2, width: size, height: size, borderColor: sun, opacity: 1 - age / 0.45 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Adding the PID: a looping walkthrough in a mock editor, driven by a script

const ADD_WIDTH = 960;
const ADD_HEIGHT = 540;
const LINE_HEIGHT = 25;
const CODE_TOP = 52;
const CODE_LEFT = 52;
/** Width of one character of 15px IBM Plex Mono. */
const CHAR_WIDTH = 9;

interface Segment {
  text: string;
  /** Seconds when it appears, highlighted, e.g. when the toolbox inserts it. */
  appearsAt?: number;
  /** Seconds when it is selected, until it is removed. */
  selectAt?: number;
  removedAt?: number;
  /** Typed in character by character between these times. */
  typed?: { start: number; end: number };
}

interface ScriptLine {
  id: string;
  segments: Segment[];
  /** Seconds when the whole line appears (grows in) or is deleted (collapses). */
  appearsAt?: number;
  deletedAt?: number;
  /** Seconds when the whole line is selected, until it is deleted. */
  selectAt?: number;
  /** Shows a blinking caret at the end of the line between these times. */
  caret?: { from: number; to: number };
}

interface PointerKey {
  time: number;
  x: number;
  y: number;
}

interface AddScript {
  pidName: string;
  loopSeconds: number;
  lines: ScriptLine[];
  pointer: PointerKey[];
  /** Click times, in order: toolbox, PID item, Insert usage, Start, plus any clicks in the code. */
  clicks: number[];
  menu: { open: number; selectPid: number; insert: number };
  start: number;
  steps: { start: number; text: string }[];
}

const TOOLBOX_BUTTON = { x: 560, y: 22 };
const MENU = { x: 390, y: 46, width: 300 };
const PID_ITEM = { x: MENU.x + 70, y: MENU.y + 82 };
const INSERT_BUTTON = { x: MENU.x + 230, y: MENU.y + 30 };
const START_BUTTON = { x: 790, y: 22 };
const PARKED = { x: 880, y: 400 };

const plain = (id: string, text: string, extra: Partial<ScriptLine> = {}): ScriptLine => ({ id, segments: [{ text }], ...extra });

/** Pointer position over a character, using the layout before anything is inserted or deleted. */
function codePoint(lines: ScriptLine[], id: string, column: number): { x: number; y: number } {
  const before = lines.slice(0, lines.findIndex((line) => line.id === id)).filter((line) => line.appearsAt === undefined);
  return { x: CODE_LEFT + column * CHAR_WIDTH, y: CODE_TOP + before.length * LINE_HEIGHT + 14 };
}

function setupLines(id: string, at: number, gains: string, name: string, comment: string): ScriptLine[] {
  return [
    plain(`${id}-comment`, comment, { appearsAt: at }),
    plain(`${id}-1`, `const ${name} = createPidController({`, { appearsAt: at }),
    plain(`${id}-2`, `  ${gains}, …`, { appearsAt: at }),
    plain(`${id}-3`, '});', { appearsAt: at }),
    plain(`${id}-gap`, '', { appearsAt: at }),
  ];
}

const DISTANCE_SCRIPT: AddScript = (() => {
  const t = { select: 1.0, deleted: 2.6, typeStart: 3.0, typeEnd: 4.0, toolbox: 4.8, pid: 5.7, insert: 6.6, semi: 7.8, start: 9.4 };
  const lines: ScriptLine[] = [
    plain('intro', '// Your car runs this function about 45 times a second.'),
    plain('gap', ''),
    ...setupLines('setup', t.insert, 'kp: 0.05, ki: 0, kd: 0.08', 'distancePid', '// Error = distance to the car ahead − the distance you want.'),
    plain('export', 'export function autopilot(input: AutopilotInput): AutopilotOutput {'),
    plain('distance', '  const closestVehicleDistance = lead ? Math.min(lead.relativeY, 100) : 100;'),
    ...['  let motor = 0.5;', '  if (closestVehicleDistance < FOLLOW_DISTANCE) {', '    motor = 0;', '  }', '  if (closestVehicleDistance < TOO_CLOSE_DISTANCE) {', '    motor = -1;', '  }'].map(
      (text, index) => plain(`old-${index}`, text, { selectAt: t.select + index * 0.18, deletedAt: t.deleted }),
    ),
    {
      id: 'motor',
      appearsAt: t.deleted,
      segments: [
        { text: '  let motor = ', typed: { start: t.typeStart, end: t.typeEnd } },
        { text: 'distancePid.update(closestVehicleDistance - 30, input.dt)', appearsAt: t.insert },
        { text: ';', typed: { start: t.semi, end: t.semi + 0.15 } },
      ],
      caret: { from: t.typeStart, to: t.semi + 0.6 },
    },
    plain('return', '  return { motor, steering };'),
    plain('close', '}'),
  ];
  const first = codePoint(lines, 'old-0', 2);
  const last = codePoint(lines, 'old-6', 3);
  return {
    pidName: 'distancePid',
    loopSeconds: 13,
    lines,
    pointer: [
      { time: 0, ...PARKED },
      { time: t.select - 0.3, ...first },
      { time: t.select, ...first },
      { time: t.deleted - 0.4, ...last },
      { time: t.typeStart, x: first.x + 120, y: first.y + 40 },
      { time: t.toolbox, ...TOOLBOX_BUTTON },
      { time: t.pid, ...PID_ITEM },
      { time: t.insert, ...INSERT_BUTTON },
      { time: t.semi, x: 700, y: 330 },
      { time: t.start, ...START_BUTTON },
      { time: 12, x: START_BUTTON.x + 40, y: START_BUTTON.y + 120 },
      { time: 13, ...PARKED },
    ],
    clicks: [t.toolbox, t.pid, t.insert, t.start],
    menu: { open: t.toolbox, selectPid: t.pid, insert: t.insert },
    start: t.start,
    steps: [
      { start: 0, text: 'Delete the bang-bang rule and the hard brake.' },
      { start: t.typeStart - 0.2, text: 'Type “let motor = ” where they were.' },
      { start: t.toolbox - 0.3, text: 'Toolbox → PID Controller Object → Insert usage.' },
      { start: t.insert + 0.2, text: 'The PID goes above autopilot; its update call goes at your cursor.' },
      { start: t.start - 0.6, text: 'Press Start, then watch distancePid in Telemetry.' },
    ],
  };
})();

const STEERING_SCRIPT: AddScript = (() => {
  const t = { select: 1.0, selected: 2.2, toolbox: 3.2, pid: 4.1, insert: 5.0, start: 7.2 };
  const lines: ScriptLine[] = [
    plain('intro', '// Your car runs this function about 45 times a second.'),
    plain('gap', ''),
    plain('distance-pid', 'const distancePid = createPidController({ … });'),
    plain('gap-2', ''),
    ...setupLines('setup', t.insert, 'kp: 0.3, ki: 0, kd: 0', 'lanePid', '// Error = distance to the lane center, in m.'),
    plain('export', 'export function autopilot(input: AutopilotInput): AutopilotOutput {'),
    plain('motor', '  const motor = distancePid.update(closestVehicleDistance - targetDistance, input.dt);'),
    plain('lane', '  const lane = analyzeLane(input.laneLines, homeLane - input.ego.laneIndex);'),
    {
      id: 'steering',
      segments: [
        { text: '  const steering = ' },
        { text: 'lane.centerOffset * 0.3', selectAt: t.select, removedAt: t.insert },
        { text: 'lanePid.update(lane.centerOffset, input.dt)', appearsAt: t.insert },
        { text: ';' },
      ],
    },
    plain('return', '  return { motor, steering };'),
    plain('close', '}'),
  ];
  const from = codePoint(lines, 'steering', 19);
  const to = codePoint(lines, 'steering', 19 + 'lane.centerOffset * 0.3'.length);
  return {
    pidName: 'lanePid',
    loopSeconds: 11,
    lines,
    pointer: [
      { time: 0, ...PARKED },
      { time: t.select - 0.3, ...from },
      { time: t.select, ...from },
      { time: t.selected, ...to },
      { time: t.toolbox, ...TOOLBOX_BUTTON },
      { time: t.pid, ...PID_ITEM },
      { time: t.insert, ...INSERT_BUTTON },
      { time: t.start, ...START_BUTTON },
      { time: 10, x: START_BUTTON.x + 40, y: START_BUTTON.y + 120 },
      { time: 11, ...PARKED },
    ],
    clicks: [t.toolbox, t.pid, t.insert, t.start],
    menu: { open: t.toolbox, selectPid: t.pid, insert: t.insert },
    start: t.start,
    steps: [
      { start: 0, text: 'Select lane.centerOffset * 0.3.' },
      { start: t.toolbox - 0.3, text: 'Toolbox → PID Controller Object → Insert usage.' },
      { start: t.insert + 0.2, text: 'lanePid starts out identical: kp 0.3, no I or D.' },
      { start: t.start - 0.6, text: 'Press Start, then tune lanePid. Add D to stop the weaving.' },
    ],
  };
})();

function pointerAt(path: PointerKey[], time: number): { x: number; y: number } {
  const next = path.findIndex((key) => key.time > time);
  if (next <= 0) return path[path.length - 1];
  const from = path[next - 1];
  const to = path[next];
  const progress = ease(between(time, from.time, to.time));
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}

function lineHeight(line: ScriptLine, time: number): number {
  if (line.deletedAt !== undefined) return 1 - ease(between(time, line.deletedAt, line.deletedAt + 0.35));
  if (line.appearsAt !== undefined) return ease(between(time, line.appearsAt, line.appearsAt + 0.35));
  return 1;
}

function segmentText(segment: Segment, time: number): string {
  if (segment.appearsAt !== undefined && time < segment.appearsAt) return '';
  if (segment.removedAt !== undefined && time >= segment.removedAt) return '';
  if (!segment.typed) return segment.text;
  return segment.text.slice(0, Math.round(segment.text.length * between(time, segment.typed.start, segment.typed.end)));
}

/** Fades from 1 to 0 over the 1.8 s after `at`. */
const glowAfter = (at: number | undefined, time: number) =>
  at !== undefined && time >= at && time < at + 1.8 ? 1 - between(time, at + 0.6, at + 1.8) : 0;

function AddPidAnimation({ script }: { script: AddScript }) {
  const time = useClock(script.loopSeconds - 2) % script.loopSeconds;
  const pointer = pointerAt(script.pointer, time);
  const lastClick = [...script.clicks].reverse().find((click) => click <= time);
  const pressed = lastClick !== undefined && time - lastClick < 0.12;
  const menuOpen = time >= script.menu.open && time < script.menu.insert + 0.15;
  const pidSelected = time >= script.menu.selectPid;
  const running = time >= script.start;
  const stepIndex = script.steps.reduce((current, step, index) => (time >= step.start ? index : current), 0);

  let top = CODE_TOP;
  let visibleCount = 0;
  const rows = script.lines.map((line) => {
    const height = lineHeight(line, time) * LINE_HEIGHT;
    // Number lines the way the editor would: only lines that are there right now count.
    if (height > LINE_HEIGHT / 2) visibleCount += 1;
    const row = { line, top, height, number: visibleCount };
    top += height;
    return row;
  });

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border-[3px] border-[#1d1b2e]" style={{ background: editor.background }}>
      {/* Editor chrome */}
      <div className="absolute inset-x-0 top-0 flex h-11 items-center border-b px-3 font-mono text-sm" style={{ background: editor.chrome, borderColor: editor.border, color: editor.muted }}>
        <span className="border-b-2 pb-2 pt-2.5" style={{ color: editor.text, borderColor: editor.signal }}>
          Autopilot.ts
        </span>
        <span
          className="absolute rounded-md border px-2.5 py-1 font-sans text-sm"
          style={{
            left: TOOLBOX_BUTTON.x - 46,
            top: 8,
            color: editor.text,
            borderColor: menuOpen ? editor.signal : editor.border,
            background: menuOpen ? '#18262a' : 'transparent',
          }}
        >
          🔧 Toolbox
        </span>
        <span
          className="absolute rounded-md px-3 py-1 font-sans text-sm font-semibold"
          style={{ left: START_BUTTON.x - 40, top: 8, background: running ? editor.signal : editor.text, color: editor.background }}
        >
          {running ? '❚❚ Pause' : '▶ Start'}
        </span>
      </div>

      {/* Code */}
      <div className="absolute inset-0 font-mono text-[15px]">
        {rows.map(({ line, top: rowTop, height, number }) => {
          if (height <= 0.5) return null;
          const lineSelected = line.selectAt !== undefined && time >= line.selectAt && time < (line.deletedAt ?? Infinity);
          const lineGlow = glowAfter(line.appearsAt, time);
          const caretOn = line.caret && time >= line.caret.from && time < line.caret.to && Math.floor(time * 3) % 2 === 0;
          return (
            <div
              key={line.id}
              className="absolute inset-x-0 overflow-hidden whitespace-pre"
              style={{
                top: rowTop,
                height,
                lineHeight: `${LINE_HEIGHT}px`,
                paddingLeft: CODE_LEFT,
                background: lineSelected ? editor.selection : lineGlow > 0 ? `rgba(255, 210, 63, ${0.28 * lineGlow})` : 'transparent',
              }}
            >
              <span className="absolute left-0 w-9 text-right" style={{ color: '#3f4d51' }}>
                {number}
              </span>
              {line.segments.map((segment, index) => {
                const text = segmentText(segment, time);
                if (!text) return null;
                const selected = segment.selectAt !== undefined && time >= segment.selectAt && time < (segment.removedAt ?? Infinity);
                const glow = glowAfter(segment.appearsAt, time);
                return (
                  <span
                    key={index}
                    style={{ background: selected ? editor.selection : glow > 0 ? `rgba(255, 210, 63, ${0.35 * glow})` : 'transparent' }}
                  >
                    <Highlighted text={text} />
                  </span>
                );
              })}
              {caretOn ? <span style={{ color: editor.signal }}>▍</span> : null}
            </div>
          );
        })}
      </div>

      {/* Toolbox menu */}
      {menuOpen ? (
        <div
          className="deck-pop absolute z-10 rounded-lg border p-2 font-sans text-sm shadow-xl"
          style={{ left: MENU.x, top: MENU.y, width: MENU.width, background: '#0e1416', borderColor: editor.border, color: editor.text }}
        >
          <div className="flex items-center justify-between pb-1">
            <span className="font-semibold">{pidSelected ? 'PID Controller Object' : 'Clamp Helper'}</span>
            <span className="rounded px-2 py-0.5 text-xs font-semibold" style={{ background: editor.text, color: editor.background }}>
              {'{ }'} Insert usage
            </span>
          </div>
          {['Clamp Helper', 'Vehicle Filtering', 'PID Controller Object', 'Lane Reading'].map((item) => (
            <div
              key={item}
              className="rounded px-2 py-1"
              style={{
                background: (item === 'PID Controller Object' ? pidSelected : item === 'Clamp Helper' && !pidSelected) ? '#1b2629' : 'transparent',
                color: item === 'PID Controller Object' && pidSelected ? editor.text : editor.muted,
              }}
            >
              {item}
            </div>
          ))}
        </div>
      ) : null}

      {/* Telemetry peek once running */}
      {running ? (
        <div
          className="deck-pop absolute right-4 top-14 z-10 rounded-lg border px-3 py-2 font-sans text-xs"
          style={{ background: editor.chrome, borderColor: editor.border, color: editor.text }}
        >
          <div className="font-semibold">{script.pidName}</div>
          <div className="mt-1 flex gap-3 font-mono" style={{ color: editor.muted }}>
            {['E', 'P', 'I', 'D', 'Out'].map((term) => (
              <span key={term}>{term}</span>
            ))}
          </div>
        </div>
      ) : null}

      {script.clicks.map((click) => (
        <Ripple key={click} x={pointer.x + 4} y={pointer.y + 4} age={time - click} />
      ))}
      <Pointer x={pointer.x} y={pointer.y} pressed={pressed} />

      {/* Step caption */}
      <div className="absolute inset-x-3 bottom-3 z-20 flex items-center gap-3 rounded-xl border-[3px] border-[#1d1b2e] bg-white px-3 py-2" style={{ color: ink }}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[3px] border-[#1d1b2e] text-lg font-black" style={{ background: sun }}>
          {stepIndex + 1}
        </span>
        <span key={stepIndex} className="deck-enter text-xl font-black">
          {script.steps[stepIndex].text}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the graphs are: a labelled mock of the Telemetry panel

const GUIDE_WIDTH = 960;
const GUIDE_HEIGHT = 380;

function TelemetryGuide({ pidName }: { pidName: string }) {
  const time = useClock(3);
  const wave = (offset: number, amplitude: number, decay = 0.25) =>
    Array.from({ length: 61 }, (_, index) => {
      const x = index / 60;
      const local = (time * 0.35 + x) % 1;
      const value = Math.exp(-local * 4 * decay * 4) * Math.cos(local * 22 + offset) * amplitude;
      return `${index === 0 ? 'M' : 'L'}${(x * 520).toFixed(1)},${(60 - value * 50).toFixed(1)}`;
    }).join('');

  return (
    <div className="grid h-full w-full grid-cols-[600px_minmax(0,1fr)] gap-5">
      <div className="relative overflow-hidden rounded-xl border-[3px] border-[#1d1b2e] p-4 font-sans" style={{ background: editor.background, color: editor.text }}>
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold">Telemetry</span>
          <span className="flex items-center gap-1.5 text-sm" style={{ color: editor.muted }}>
            ⤢ Explore telemetry
            <Badge number={3} />
          </span>
        </div>
        <div className="relative mt-3 rounded-lg border p-3" style={{ borderColor: editor.border }}>
          <div className="flex items-center gap-2 text-base font-semibold">
            {pidName} <Badge number={1} />
          </div>
          <div className="mt-2 grid grid-cols-5 gap-px overflow-hidden rounded border font-mono text-sm" style={{ borderColor: editor.border, background: editor.border }}>
            {[
              ['E', '+12.4'],
              ['P', '+0.62'],
              ['I', '0.00'],
              ['D', '−0.21'],
              ['Out', '+0.40'],
            ].map(([label, value]) => (
              <div key={label} className="px-2 py-1.5" style={{ background: editor.background }}>
                <div className="text-xs" style={{ color: editor.muted }}>
                  {label}
                </div>
                <div>{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm" style={{ color: editor.text }}>
            ⌄ History <Badge number={2} />
          </div>
          <svg viewBox="0 0 520 120" className="mt-1 h-[120px] w-full">
            <line x1={0} x2={520} y1={60} y2={60} stroke={editor.border} />
            <path d={wave(0, 0.9)} fill="none" stroke={cherry} strokeWidth={2.5} />
            <path d={wave(0.3, 0.6)} fill="none" stroke={sky} strokeWidth={2} />
            <path d={wave(1.4, 0.35)} fill="none" stroke={bubblegum} strokeWidth={2} />
          </svg>
        </div>
      </div>

      <ol className="grid content-center gap-4">
        <GuideNote number={1}>
          Your PID shows up here, under its name, once the car is running.
        </GuideNote>
        <GuideNote number={2}>
          Open <b>History</b> to graph the error and each term over time.
        </GuideNote>
        <GuideNote number={3}>
          <b>Explore telemetry</b> opens big graphs where you can pick any signal.
        </GuideNote>
      </ol>
    </div>
  );
}

function Badge({ number }: { number: number }) {
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[3px] border-[#1d1b2e] font-black"
      style={{ background: sun, color: ink, fontSize: 15 }}
    >
      {number}
    </span>
  );
}

function GuideNote({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-xl font-bold leading-snug" style={{ color: ink }}>
      <Badge number={number} />
      <span>{children}</span>
    </li>
  );
}

