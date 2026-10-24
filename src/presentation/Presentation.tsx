import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import App from '../App';
import { writeStoredJson } from '../multiplayer/connection';
import { HOST_SESSION_KEY, useHostRoom, type HostRoom } from '../multiplayer/hostRoom';
import { DEFAULT_PRESENTATION, settingsFromPush, type SettingsPush } from '../multiplayer/protocol';
import {
  brakingStarterExample,
  checkpointExamples,
  pidCheckpointExample,
  raceReadyExample,
  starterExample,
  steeringPidCheckpointExample,
  tunedFollowingExample,
  tunedSteeringExample,
  type ControllerExample,
} from '../toolbox';
import { toolboxSnippets } from '../toolbox/snippets';
import { DeckButton, Toggle } from './controls';
import { CheatSheet } from './CheatSheet';
import { DemoRace } from './DemoRace';
import { FeedforwardExplainer } from './FeedforwardExplainer';
import { BeforeRacing, LaneChangeQuestion, LateralVelocityExplainer } from './LaneChangeSlides';
import { PidPlayground } from './PidPlayground';
import { cherry, deckFontStyle, lawnStyle, mint, panel, sky, sun } from './theme';

interface Slide {
  id: string;
  /** Header for slides that use the live editor or the full-width stage below it. */
  heading?: { title: string; hint: string };
  /** Shows the presenter's editor in the stage area, with this slide's own saved code. */
  editor?: EditorSetup;
  /** Content drawn in the stage area, or full screen when there is no heading. */
  render?: (room: HostRoom) => ReactNode;
  /** Opens race submissions when the presenter reaches this slide. */
  opensSubmissions?: boolean;
  /** Closes race submissions when the presenter reaches this slide. */
  closesSubmissions?: boolean;
  /** Toolbox snippet ids players can see from this slide on. */
  unlocksHelpers?: string[];
  /** Example players can "Catch up to presenter" with from this slide on. */
  checkpointId?: string;
  /** Settings everyone (presenter included) applies once on reaching this slide. */
  settingsPush?: SettingsPush;
  /** Full-screen slides that draw their own room code, such as the race. */
  ownsChrome?: boolean;
}

// The race view is large and only needed on the last slide.
const HostView = lazy(() => import('../multiplayer/HostView').then((module) => ({ default: module.HostView })));

interface EditorSetup {
  /** Where this slide's code is saved, so each editor slide keeps its own. */
  storageNamespace: string;
  /** The code the slide starts from, also what "Start over" restores. */
  examples: ControllerExample[];
}

const BANG_BANG_EDITOR: EditorSetup = { storageNamespace: 'presentation:bang-bang:', examples: [starterExample] };
/** Starts where the bang-bang demo ends: with the hard brake added. */
const PID_EDITOR: EditorSetup = { storageNamespace: 'presentation:pid:', examples: [brakingStarterExample] };
const TUNED_EDITOR: EditorSetup = { storageNamespace: 'presentation:tuned:', examples: [tunedFollowingExample] };
/** The steering PID demo starts from the tuned following code. */
const STEERING_PID_EDITOR: EditorSetup = { storageNamespace: 'presentation:steering-pid:', examples: [tunedFollowingExample] };
const TUNED_STEERING_EDITOR: EditorSetup = { storageNamespace: 'presentation:tuned-steering:', examples: [tunedSteeringExample] };
/** The feedforward demo starts from the tuned steering code. */
const FEEDFORWARD_EDITOR: EditorSetup = { storageNamespace: 'presentation:feedforward:', examples: [tunedSteeringExample] };

const SLIDES: Slide[] = [
  { id: 'title', render: (room) => <TitleSlide room={room} /> },
  { id: 'mission', render: () => <MissionSlide /> },
  {
    id: 'bang-bang',
    heading: { title: 'Bang-bang control', hint: 'Go, or coast: one of two fixed commands. What could go wrong?' },
    editor: BANG_BANG_EDITOR,
  },
  {
    id: 'pid',
    heading: { title: 'PID: push in proportion to the error', hint: 'Drag the sliders. Click the road to move the flag.' },
    render: () => <PidPlayground />,
  },
  {
    id: 'add-pid',
    heading: { title: 'Your turn: add a PID loop', hint: 'Toolbox → PID Controller Object → Insert usage' },
    editor: PID_EDITOR,
    checkpointId: pidCheckpointExample.id,
  },
  {
    id: 'cheat-sheet',
    heading: { title: 'Tuning cheat sheet', hint: 'Keep this up while you tune: P first, then D, then a little I.' },
    render: () => <CheatSheet />,
  },
  {
    id: 'tuned',
    heading: { title: 'What I came up with', hint: 'Close in slow traffic, more room at speed. Explore the Toolbox for more, like speed feedforward.' },
    editor: TUNED_EDITOR,
    checkpointId: tunedFollowingExample.id,
  },
  {
    id: 'steering-pid',
    heading: { title: 'Steering with a PID', hint: '"Steer for me" is off now. Replace lane.centerOffset * 0.3 with a PID.' },
    editor: STEERING_PID_EDITOR,
    settingsPush: { id: 'steer-off-for-steering-pid', steerAssist: false },
    checkpointId: steeringPidCheckpointExample.id,
  },
  {
    id: 'steering-cheat-sheet',
    heading: { title: 'Tuning cheat sheet: steering', hint: 'Now tune lanePid. Add D to stop the weaving, then raise P.' },
    render: () => <CheatSheet variant="steering" />,
  },
  {
    id: 'tuned-steering',
    heading: { title: 'What I came up with', hint: 'Steady on the straights. Watch what happens in the curves.' },
    editor: TUNED_STEERING_EDITOR,
    checkpointId: tunedSteeringExample.id,
  },
  {
    id: 'feedforward',
    heading: { title: 'Feedforward: act on what you know is coming', hint: 'Both cars use the same feedback. Only one looks ahead.' },
    render: () => <FeedforwardExplainer />,
  },
  {
    id: 'add-feedforward',
    heading: { title: 'Adding steering feedforward', hint: 'Click just before the ; after the PID call, type +, then Toolbox → Steering Feedforward → Insert usage.' },
    editor: FEEDFORWARD_EDITOR,
  },
  {
    id: 'before-race',
    heading: { title: 'Before we start racing', hint: 'Fastest Lane Selection is now in your Toolbox.' },
    render: () => <BeforeRacing />,
    unlocksHelpers: ['fastest-lane'],
    checkpointId: raceReadyExample.id,
  },
  {
    id: 'race',
    render: () => <RaceScreen />,
    opensSubmissions: true,
    checkpointId: raceReadyExample.id,
    ownsChrome: true,
  },
  {
    id: 'lane-change-question',
    heading: { title: 'Is a PID the right way to change lanes?', hint: 'Racing is paused. Watch both cars move over one lane.' },
    render: () => <LaneChangeQuestion />,
    closesSubmissions: true,
  },
  {
    id: 'lateral-velocity',
    heading: { title: 'Lateral velocity control', hint: 'Lateral Velocity Steering is now in your Toolbox.' },
    render: () => <LateralVelocityExplainer />,
    unlocksHelpers: ['lateral-velocity'],
  },
  {
    id: 'race-again',
    render: () => <RaceScreen />,
    opensSubmissions: true,
    ownsChrome: true,
  },
  { id: 'thanks', render: () => <ThanksSlide /> },
];

/** The /host race screen. Leaving the slide stops the race; coming back starts again from the lobby. */
function RaceScreen() {
  return (
    <Suspense fallback={null}>
      <HostView />
    </Suspense>
  );
}

/** Area below the slide heading where the editor and full-width demos live. */
const STAGE = 'absolute inset-x-6 bottom-6 top-[8.5rem]';

const FRESH_START_FLAG = 'self-driving-playground:deck-fresh-start';
const DECK_STORAGE_PREFIX = 'self-driving-playground:presentation:';

/**
 * New room, the deck's editors back to their starting code, and back to slide 1. Reloads first,
 * so nothing from the old run is still in memory to copy into the new room.
 */
function startFresh(): void {
  window.sessionStorage.setItem(FRESH_START_FLAG, '1');
  window.location.hash = '#1';
  window.location.reload();
}

/**
 * After a fresh-start reload, forgets the deck's saved editor code and room before anything reads
 * them. With no saved room, the deck creates a new one as on a first visit.
 */
function applyFreshStart(): void {
  if (!window.sessionStorage.getItem(FRESH_START_FLAG)) return;
  window.sessionStorage.removeItem(FRESH_START_FLAG);
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(DECK_STORAGE_PREFIX)) window.localStorage.removeItem(key);
  }
  writeStoredJson(HOST_SESSION_KEY, undefined);
}

/** True when the room still has progress from an earlier run through the slides, like a rehearsal. */
function roomHasProgress(room: HostRoom): boolean {
  const { presentation } = room;
  return (
    room.ready &&
    (presentation.submissionsOpen ||
      presentation.checkpointId !== undefined ||
      presentation.settingsPush !== undefined ||
      presentation.lockedHelpers.join() !== DEFAULT_PRESENTATION.lockedHelpers.join())
  );
}

export function Presentation() {
  useState(applyFreshStart);
  const room = useHostRoom();
  const [index, setIndex] = useState(readSlideFromHash);
  const slide = SLIDES[index];
  const settingsPushState = room.presentation.settingsPush;
  // Scoped to the room like players' pushes, so a rehearsal doesn't stop it applying in the talk.
  const settingsPush = useMemo(() => {
    const push = settingsFromPush(settingsPushState);
    return push && room.roomCode ? { ...push, id: `${room.roomCode}:${push.id}` } : undefined;
  }, [settingsPushState, room.roomCode]);
  // The hidden editor keeps the last editor slide's code until another editor slide is shown.
  const [editorSetup, setEditorSetup] = useState<EditorSetup>(() => slide.editor ?? BANG_BANG_EDITOR);
  useEffect(() => {
    if (slide.editor) setEditorSetup(slide.editor);
  }, [slide]);

  const go = useCallback((delta: number) => {
    setIndex((current) => Math.max(0, Math.min(SLIDES.length - 1, current + delta)));
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `#${index + 1}`);
  }, [index]);

  // Typing a slide number into the URL jumps there.
  useEffect(() => {
    const onHashChange = () => setIndex(readSlideFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // The furthest slide reached so far. Progress (checkpoint, unlocks, settings push) never goes
  // backward when you revisit an earlier slide, and jumping ahead includes everything before it.
  // Saved per room, so refreshing the deck on an earlier slide doesn't move progress back either.
  const furthestRef = useRef(index);
  furthestRef.current = Math.max(furthestRef.current, index);

  // Applied once per slide visit and room, after the room's saved state has loaded, so manual
  // changes in the presenter panel stick until the next slide, and a new room catches up at once.
  const appliedKeyRef = useRef<string>();
  useEffect(() => {
    if (!room.ready || !room.roomCode) return;
    const key = `${room.roomCode}:${index}`;
    if (appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    const furthestKey = `${DECK_STORAGE_PREFIX}furthest-slide:${room.roomCode}`;
    furthestRef.current = Math.max(furthestRef.current, Number(window.localStorage.getItem(furthestKey)) || 0);
    window.localStorage.setItem(furthestKey, String(furthestRef.current));
    const { presentation } = room;
    const next = { ...presentation };
    for (const reached of SLIDES.slice(0, furthestRef.current + 1)) {
      if (reached.checkpointId) next.checkpointId = reached.checkpointId;
      if (reached.settingsPush) next.settingsPush = reached.settingsPush;
      if (reached.unlocksHelpers) next.lockedHelpers = next.lockedHelpers.filter((id) => !reached.unlocksHelpers!.includes(id));
    }
    // Submissions follow the slide you're on: race slides open them, the lane change slide closes them.
    if (slide.opensSubmissions) next.submissionsOpen = true;
    if (slide.closesSubmissions) next.submissionsOpen = false;
    if (
      next.submissionsOpen !== presentation.submissionsOpen ||
      next.checkpointId !== presentation.checkpointId ||
      next.lockedHelpers.join() !== presentation.lockedHelpers.join() ||
      next.settingsPush?.id !== presentation.settingsPush?.id
    ) {
      room.updatePresentation(next);
    }
  }, [index, slide, room]);

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
          examples={editorSetup.examples}
          storageNamespace={editorSetup.storageNamespace}
          lockedHelpers={room.presentation.lockedHelpers}
          settingsPush={settingsPush}
          editorFontSize={16}
          active={Boolean(slide.editor)}
        />
      </div>

      {/* Full-screen slides like the race show the room code themselves; keep the controls out of their way. */}
      <div className={`absolute z-20 flex items-start gap-3 ${slide.ownsChrome ? 'left-4 top-[7.5rem]' : 'right-6 top-6'}`}>
        <DeckNav index={index} total={SLIDES.length} onGo={go} room={room} />
        {slide.id === 'title' || slide.ownsChrome ? null : <JoinBadge room={room} />}
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
      <label className="mt-3 block border-t-[3px] border-[#1d1b2e] pt-3">
        <span className="mb-1 block text-sm opacity-60">Catch up to presenter</span>
        <select
          value={presentation.checkpointId ?? ''}
          onChange={(event) => updatePresentation({ ...presentation, checkpointId: event.target.value || undefined })}
          className="w-full rounded-lg border-[3px] border-[#1d1b2e] bg-white px-2 py-1 text-sm"
        >
          <option value="">Off</option>
          {checkpointExamples.map((example) => (
            <option key={example.id} value={example.id}>
              {example.title}
            </option>
          ))}
        </select>
      </label>
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
        <DeckButton
          onClick={() => {
            if (window.confirm('Start fresh? This opens a new room with a new code (everyone will need to rejoin) and resets the code on the deck\'s editor slides.')) {
              startFresh();
            }
          }}
        >
          Start fresh (new room)
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
      {roomHasProgress(room) ? (
        <div className={`absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 px-5 py-3 ${panel}`} style={{ background: sun }}>
          <span className="text-lg font-black">This room still has progress from a run-through (catch-up, unlocks, racing).</span>
          <DeckButton onClick={startFresh}>Start fresh for the talk</DeckButton>
        </div>
      ) : null}
    </>
  );
}

const CONTACTS = [
  { label: 'Email', value: 'hi@adalie.me', href: 'mailto:hi@adalie.me', color: sky },
  { label: 'Bluesky', value: '@adalie.me', href: 'https://bsky.app/profile/adalie.me', color: mint },
  { label: 'Website', value: 'adalie.me', href: 'https://adalie.me', color: sun },
];

function ThanksSlide() {
  return (
    <>
      <div className="absolute inset-0">
        <DemoRace scale={11} seed={142} />
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-10">
        <div className={`deck-pop w-[min(56rem,100%)] px-12 py-10 text-center ${panel}`} style={{ animationDelay: '150ms' }}>
          <h1 className="text-8xl font-black leading-none">Thank you!</h1>
          <p className="mt-4 inline-block -rotate-1 rounded-xl border-[3px] border-[#1d1b2e] px-4 py-1 text-3xl font-black" style={{ background: sun }}>
            Keep tuning, and keep in touch
          </p>
          <div className="mt-8 grid gap-3">
            {[
              // The solo playground on whatever host is serving the deck, e.g. driving.adalie.me/playground.
              { label: 'Keep practicing', value: `${joinHost()}/playground`, href: '/playground', color: '#ff7ac6' },
              ...CONTACTS,
            ].map((contact) => (
              <a
                key={contact.label}
                href={contact.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-4 rounded-2xl border-[3px] border-[#1d1b2e] px-6 py-3 shadow-[4px_4px_0_#1d1b2e]"
                style={{ background: contact.color }}
              >
                <span className="text-2xl font-black opacity-70">{contact.label}</span>
                <span className="text-4xl font-black">{contact.value}</span>
              </a>
            ))}
          </div>
          <a
            href="https://betterlyrics.org"
            target="_blank"
            rel="noreferrer"
            className="mt-6 flex items-center gap-4 rounded-2xl border-[3px] border-dashed border-[#1d1b2e] px-6 py-3 text-left"
          >
            <img src="/better-lyrics-logo.png" alt="Better Lyrics logo" className="h-16 w-16 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-black opacity-60">Also from me: a project I maintain</span>
              <span className="block text-2xl font-black">Better Lyrics</span>
              <span className="block text-lg font-bold opacity-75">Free, open-source time-synced lyrics for YouTube Music, used by about 140k people every week.</span>
            </span>
            <span className="text-2xl font-black" style={{ color: sky }}>
              betterlyrics.org
            </span>
          </a>
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
