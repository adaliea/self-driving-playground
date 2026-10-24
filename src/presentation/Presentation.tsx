import { useCallback, useEffect, useState, type ReactNode } from 'react';
import App from '../App';
import { useHostRoom, type HostRoom } from '../multiplayer/hostRoom';
import { starterExample } from '../toolbox';
import { toolboxSnippets } from '../toolbox/snippets';
import { DeckButton, Toggle } from './controls';
import { DemoRace } from './DemoRace';
import { PidPlayground } from './PidPlayground';
import { cherry, deckFontStyle, lawnStyle, mint, panel, sky, sun } from './theme';

interface Slide {
  id: string;
  /** Header for slides that use the live editor or the full-width stage below it. */
  heading?: { title: string; hint: string };
  /** Shows the presenter's editor in the stage area. */
  editor?: boolean;
  /** Content drawn in the stage area, or full screen when there is no heading. */
  render?: (room: HostRoom) => ReactNode;
  /** Opens race submissions when the presenter reaches this slide. */
  opensSubmissions?: boolean;
}

const SLIDES: Slide[] = [
  { id: 'title', render: (room) => <TitleSlide room={room} /> },
  { id: 'mission', render: () => <MissionSlide /> },
  {
    id: 'bang-bang',
    heading: { title: 'Bang-bang control', hint: 'Full power, or nothing at all. What could go wrong?' },
    editor: true,
  },
  {
    id: 'pid',
    heading: { title: 'PID: push in proportion to the error', hint: 'Drag the sliders. Click the road to move the flag.' },
    render: () => <PidPlayground />,
  },
  {
    id: 'add-pid',
    heading: { title: 'Your turn: add a PID loop', hint: 'Toolbox → PID Controller Object → Insert usage' },
    editor: true,
  },
];

const PRESENTATION_EXAMPLES = [starterExample];
/** Area below the slide heading where the editor and full-width demos live. */
const STAGE = 'absolute inset-x-6 bottom-6 top-[8.5rem]';

export function Presentation() {
  const room = useHostRoom();
  const [index, setIndex] = useState(readSlideFromHash);
  const slide = SLIDES[index];

  const go = useCallback((delta: number) => {
    setIndex((current) => Math.max(0, Math.min(SLIDES.length - 1, current + delta)));
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `#${index + 1}`);
  }, [index]);

  useEffect(() => {
    if (slide.opensSubmissions && !room.presentation.submissionsOpen) {
      room.updatePresentation({ ...room.presentation, submissionsOpen: true });
    }
  }, [slide, room]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      // Clickers send PageUp/PageDown, so those always navigate. Other keys belong to whatever is focused.
      const pager = event.key === 'PageDown' || event.key === 'PageUp';
      const typing = target?.closest('.monaco-editor, input, textarea, select, [contenteditable="true"]');
      const pressingButton = target?.closest('button') && (event.key === ' ' || event.key === 'Enter');
      if (!pager && (typing || pressingButton)) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) go(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go]);

  return (
    <div className="relative h-screen w-screen overflow-hidden" style={{ ...deckFontStyle, ...lawnStyle }}>
      <div key={slide.id} className="deck-enter absolute inset-0">
        {slide.heading ? <SlideHeading {...slide.heading} /> : null}
        {slide.render ? (slide.heading ? <div className={STAGE}>{slide.render(room)}</div> : slide.render(room)) : null}
      </div>

      {/* One editor for every editor slide, so code, the running simulation and the compiler survive navigation. */}
      <div
        className={`${STAGE} overflow-hidden ${panel} ${slide.editor ? 'deck-enter' : 'pointer-events-none'}`}
        style={{ visibility: slide.editor ? 'visible' : 'hidden' }}
        aria-hidden={!slide.editor}
      >
        <App
          embedded
          examples={PRESENTATION_EXAMPLES}
          storageNamespace="presentation:"
          lockedHelpers={room.presentation.lockedHelpers}
          editorFontSize={16}
          active={Boolean(slide.editor)}
        />
      </div>

      <div className="absolute right-6 top-6 z-20 flex items-start gap-3">
        <DeckNav index={index} total={SLIDES.length} onGo={go} room={room} />
        {slide.id === 'title' ? null : <JoinBadge room={room} />}
      </div>
    </div>
  );
}

function readSlideFromHash(): number {
  const number = Number.parseInt(window.location.hash.slice(1), 10);
  return Number.isFinite(number) ? Math.max(0, Math.min(SLIDES.length - 1, number - 1)) : 0;
}

function SlideHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={`absolute left-6 top-6 max-w-[calc(100%-34rem)] px-5 py-3 ${panel}`}>
      <h1 className="text-4xl font-black leading-tight">{title}</h1>
      <p className="mt-0.5 text-lg font-bold opacity-70">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room chrome

function joinHost(): string {
  return window.location.host;
}

function JoinBadge({ room }: { room: HostRoom }) {
  const connected = room.players.filter((player) => player.connected).length;
  return (
    <div className={`px-4 py-2 ${panel}`}>
      <div className="text-sm font-black opacity-60">Join at {joinHost()}</div>
      <div className="flex items-center gap-3">
        <span className="text-4xl font-black tracking-[0.2em]">{room.roomCode ?? '·····'}</span>
        <span className="rounded-full border-[3px] border-[#1d1b2e] px-2.5 text-lg font-black tabular-nums" style={{ background: sun }}>
          {connected} 👋
        </span>
      </div>
      {room.status !== 'open' ? <div className="text-xs font-black" style={{ color: cherry }}>{room.status}…</div> : null}
    </div>
  );
}

function DeckNav({ index, total, onGo, room }: { index: number; total: number; onGo: (delta: number) => void; room: HostRoom }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-col items-end gap-2">
      <div className={`flex items-center gap-1 px-1.5 py-1 ${panel}`}>
        <NavButton label="Previous slide" onClick={() => onGo(-1)} disabled={index === 0}>
          ◀
        </NavButton>
        <span className="px-1 text-base font-black tabular-nums">
          {index + 1}/{total}
        </span>
        <NavButton label="Next slide" onClick={() => onGo(1)} disabled={index === total - 1}>
          ▶
        </NavButton>
        <NavButton label="Presenter controls" onClick={() => setOpen((current) => !current)}>
          ⚙
        </NavButton>
      </div>
      {open ? <PresenterPanel room={room} /> : null}
    </div>
  );
}

function NavButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-lg font-black transition-colors hover:bg-[#ffd23f] disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function PresenterPanel({ room }: { room: HostRoom }) {
  const { presentation, updatePresentation } = room;
  return (
    <div className={`deck-pop w-80 max-h-[calc(100vh-7rem)] overflow-auto p-4 text-base font-black ${panel}`}>
      <div className="text-sm opacity-60">Room {room.roomCode} · {room.status}</div>
      <div className="mt-3 border-t-[3px] border-[#1d1b2e] pt-3">
        <Toggle checked={presentation.submissionsOpen} onChange={(submissionsOpen) => updatePresentation({ ...presentation, submissionsOpen })}>
          Submissions open
        </Toggle>
      </div>
      <div className="mt-3 border-t-[3px] border-[#1d1b2e] pt-3">
        <div className="mb-1 text-sm opacity-60">Toolbox players can see</div>
        {toolboxSnippets.map((snippet) => {
          const unlocked = !presentation.lockedHelpers.includes(snippet.id);
          return (
            <div key={snippet.id} className="py-0.5">
              <Toggle
                checked={unlocked}
                onChange={(next) =>
                  updatePresentation({
                    ...presentation,
                    lockedHelpers: next
                      ? presentation.lockedHelpers.filter((id) => id !== snippet.id)
                      : [...presentation.lockedHelpers, snippet.id],
                  })
                }
              >
                <span className="text-sm">{snippet.title}</span>
              </Toggle>
            </div>
          );
        })}
      </div>
      <div className="mt-3 grid gap-2 border-t-[3px] border-[#1d1b2e] pt-3">
        <a
          href="/host"
          target="_blank"
          rel="noreferrer"
          className="rounded-xl border-[3px] border-[#1d1b2e] bg-white px-3 py-2 text-center shadow-[3px_3px_0_#1d1b2e]"
        >
          Open race screen ↗
        </a>
        <DeckButton
          onClick={() => {
            if (window.confirm('Close this room and open a new one with a new code? Everyone will need to rejoin.')) void room.newRoom();
          }}
        >
          New room
        </DeckButton>
        {room.error ? <div className="text-sm" style={{ color: cherry }}>{room.error}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slides

function TitleSlide({ room }: { room: HostRoom }) {
  const code = room.roomCode ?? '·····';
  const connected = room.players.filter((player) => player.connected).length;
  return (
    <>
      <div className="absolute inset-0">
        <DemoRace scale={11} />
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-10">
        <div className={`deck-pop w-[min(64rem,100%)] px-12 py-10 text-center ${panel}`} style={{ animationDelay: '150ms' }}>
          <h1 className="text-7xl font-black leading-[1.05]">Code a Self-Driving Car</h1>
          <p className="mt-4 inline-block -rotate-1 rounded-xl border-[3px] border-[#1d1b2e] px-4 py-1 text-3xl font-black" style={{ background: sun }}>
            Introduction to Control Systems
          </p>
          <div className="mt-10 text-2xl font-black">
            Open <span style={{ color: sky }}>{joinHost()}</span> and enter
          </div>
          <div className="mt-3 flex justify-center gap-3">
            {code.split('').map((letter, position) => (
              <span
                key={`${code}-${position}`}
                className="deck-drop flex h-24 w-20 items-center justify-center rounded-2xl border-[3px] border-[#1d1b2e] text-6xl font-black shadow-[4px_4px_0_#1d1b2e]"
                style={{ background: [sun, mint, sky, '#ff7ac6', '#ffb400'][position % 5], animationDelay: `${500 + position * 90}ms` }}
              >
                {letter}
              </span>
            ))}
          </div>
          <div className="mt-6 text-xl font-black opacity-70">
            {connected === 0 ? 'Waiting for the first driver…' : `${connected} ${connected === 1 ? 'driver has' : 'drivers have'} joined`}
          </div>
        </div>
      </div>
    </>
  );
}

const MISSION_STEPS = [
  {
    title: 'Read the sensors',
    body: (
      <>
        Where the car ahead is, where the lane lines are, how fast you're going. Fresh readings <b>45 times a second</b>.
      </>
    ),
    color: sky,
  },
  {
    title: 'Decide',
    body: (
      <>
        Return two numbers: <Code>motor</Code> from −1 (brake) to 1 (gas), and <Code>steering</Code> from −1 (left) to 1 (right).
      </>
    ),
    color: sun,
  },
  {
    title: 'Race',
    body: <>At the end, every car in this room shares one road. Drive far, and don't crash into anyone.</>,
    color: '#ff7ac6',
  },
];

function MissionSlide() {
  return (
    <>
      <div className="absolute left-6 top-6 w-[44%]">
        <div className={`px-6 py-5 ${panel}`}>
          <h1 className="text-5xl font-black leading-tight">You write the driver.</h1>
          <p className="mt-2 text-2xl font-bold opacity-75">
            One function, <Code>autopilot(input)</Code>, decides everything the car does.
          </p>
        </div>
        <ol className="mt-5 grid gap-4">
          {MISSION_STEPS.map((step, position) => (
            <li key={step.title} className={`flex items-start gap-4 px-5 py-4 ${panel}`}>
              <span
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-[3px] border-[#1d1b2e] text-2xl font-black"
                style={{ background: step.color }}
              >
                {position + 1}
              </span>
              <div>
                <div className="text-2xl font-black">{step.title}</div>
                <div className="text-xl font-bold leading-snug opacity-80">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className={`absolute bottom-6 right-6 h-[58%] w-[52%] overflow-hidden ${panel}`}>
        <DemoRace scale={10} seed={21} />
        <div className="absolute left-3 top-3 rounded-xl border-[3px] border-[#1d1b2e] px-3 py-1 text-lg font-black" style={{ background: sun }}>
          Where we're headed: five finished autopilots
        </div>
      </div>
    </>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-[#1d1b2e]/10 px-1.5 font-mono text-[0.9em]">{children}</code>;
}
