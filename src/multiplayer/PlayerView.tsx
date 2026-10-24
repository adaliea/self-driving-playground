import { CheckCircle2, Flag, Loader2, LogOut, Send, ShieldCheck, Trophy, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import App, { type AppTopBarContext } from '../App';
import { checkpointExamples, starterExample } from '../toolbox';
import { Button } from '../ui/Button';
import { RoomConnection, joinRoom, readStoredJson, roomSocketUrl, writeStoredJson, type ConnectionStatus } from './connection';
import {
  DEFAULT_PRESENTATION,
  MAX_PLAYER_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  settingsFromPush,
  type DriverStatusUpdate,
  type JoinRoomResponse,
  type LeaderboardEntry,
  type PlayerToServerMessage,
  type PresentationState,
  type RoundState,
  type ServerToPlayerMessage,
  type SiteConfig,
  type ValidationReport,
} from './protocol';
import { raceSettings, DEFAULT_RACE_CONFIG } from './RaceEngine';
import { RACE_SCORING } from './scoring';
import { VALIDATION_RULES, kmh, percent } from './validation';

const PLAYER_NAME_KEY = 'self-driving-playground:player-name:v1';
/** Race rooms keep their own code and settings, separate from the solo playground. */
const ROOM_STORAGE_NAMESPACE = 'room:';
const ROOM_EXAMPLES = [starterExample];
const playerSessionKey = (roomCode: string) => `self-driving-playground:player-session:${roomCode}:v1`;

interface PlayerSession extends JoinRoomResponse {
  roomCode: string;
}

export function PlayerView({ initialRoomCode }: { initialRoomCode?: string }) {
  const [session, setSession] = useState<PlayerSession>();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string>();
  const autoJoinTried = useRef(false);

  const join = useCallback(async (roomCode: string, name: string) => {
    setJoining(true);
    setJoinError(undefined);
    try {
      const stored = readStoredJson<PlayerSession>(playerSessionKey(roomCode));
      const response = await joinRoom(roomCode, { name, playerId: stored?.playerId, playerToken: stored?.playerToken });
      const next = { ...response, roomCode };
      writeStoredJson(playerSessionKey(roomCode), next);
      writeStoredJson(PLAYER_NAME_KEY, name);
      window.history.replaceState(null, '', `/play/${roomCode}`);
      setSession(next);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : String(error));
    } finally {
      setJoining(false);
    }
  }, []);

  // Rejoin automatically after a refresh.
  useEffect(() => {
    if (autoJoinTried.current || !initialRoomCode) return;
    autoJoinTried.current = true;
    const stored = readStoredJson<PlayerSession>(playerSessionKey(initialRoomCode));
    if (stored) void join(initialRoomCode, stored.name);
  }, [initialRoomCode, join]);

  if (!session) {
    return <JoinForm initialRoomCode={initialRoomCode} joining={joining} error={joinError} onJoin={join} />;
  }

  return (
    <PlayerRoom
      session={session}
      onLeave={() => {
        // Keep this browser's credentials: rejoining the same room reuses the same player slot.
        window.location.href = '/';
      }}
    />
  );
}

function JoinForm({
  initialRoomCode,
  joining,
  error,
  onJoin,
}: {
  initialRoomCode?: string;
  joining: boolean;
  error?: string;
  onJoin: (roomCode: string, name: string) => void;
}) {
  const [roomCode, setRoomCode] = useState(initialRoomCode ?? '');
  const [name, setName] = useState(() => readStoredJson<string>(PLAYER_NAME_KEY) ?? '');
  // Hidden until the site config says otherwise, so it doesn't flash when the host has turned it off.
  const [showPracticeLink, setShowPracticeLink] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((response) => (response.ok ? (response.json() as Promise<SiteConfig>) : { showPracticeLink: true }))
      .catch(() => ({ showPracticeLink: true }))
      .then((config) => {
        if (!cancelled) setShowPracticeLink(config.showPracticeLink !== false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const valid = isValidRoomCode(roomCode) && name.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onJoin(roomCode, name.trim());
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <form onSubmit={submit} className="grid w-full max-w-sm gap-4 rounded-lg border border-border bg-card p-6">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Flag className="size-5" /> Join a race
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the room code shown on the presenter screen. You'll write an autopilot here and submit it to race.
          </p>
        </div>
        <label className="grid gap-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Room code
          <input
            value={roomCode}
            onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
            maxLength={ROOM_CODE_LENGTH}
            autoCapitalize="characters"
            autoComplete="off"
            className="h-11 rounded-md border border-input bg-background px-3 font-mono text-2xl tracking-[0.3em] text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="grid gap-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Display name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_PLAYER_NAME_LENGTH}
            className="h-10 rounded-md border border-input bg-background px-3 text-base normal-case tracking-normal text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <Button type="submit" disabled={!valid || joining}>
          {joining ? 'Joining…' : 'Join'}
        </Button>
        {showPracticeLink ? (
          <a href="/playground" className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline">
            Practice on your own instead
          </a>
        ) : null}
      </form>
    </div>
  );
}

/** The server test-drives every submission before it may race. */
type ValidationState =
  | { phase: 'validating'; queuedBehind: number; source?: string }
  | { phase: 'passed'; report: ValidationReport; source?: string; version: number }
  | { phase: 'rejected'; report: ValidationReport; source?: string };

interface RoomState {
  connection: ConnectionStatus;
  round: RoundState;
  leaderboard: LeaderboardEntry[];
  presentation: PresentationState;
  submittedVersion?: number;
  submittedSource?: string;
  /** Latest presenter status for each submitted version. */
  statusByVersion: Record<number, DriverStatusUpdate>;
  validation?: ValidationState;
  notice?: string;
}

function PlayerRoom({ session, onLeave }: { session: PlayerSession; onLeave: () => void }) {
  const [state, setState] = useState<RoomState>({
    connection: 'connecting',
    round: { phase: 'lobby', round: 0 },
    leaderboard: [],
    presentation: DEFAULT_PRESENTATION,
    statusByVersion: {},
  });
  const connectionRef = useRef<RoomConnection<ServerToPlayerMessage, PlayerToServerMessage>>();
  const pendingSourceRef = useRef<string>();

  useEffect(() => {
    const handleMessage = (message: ServerToPlayerMessage) => {
      setState((current) => {
        switch (message.type) {
          case 'welcome':
            return {
              ...current,
              round: message.round,
              presentation: message.presentation ?? current.presentation,
              submittedVersion: message.version ?? current.submittedVersion,
              validation: message.validating
                ? { phase: 'validating', queuedBehind: 0, source: pendingSourceRef.current }
                : current.validation?.phase === 'validating'
                  ? undefined
                  : current.validation,
            };
          case 'submission-validating':
            return {
              ...current,
              validation: { phase: 'validating', queuedBehind: message.queuedBehind, source: pendingSourceRef.current },
              notice: undefined,
            };
          case 'submission-accepted': {
            const source = current.validation?.source ?? pendingSourceRef.current;
            return {
              ...current,
              submittedVersion: message.version,
              submittedSource: source ?? current.submittedSource,
              validation: { phase: 'passed', report: message.report, source, version: message.version },
              notice: undefined,
            };
          }
          case 'submission-rejected':
            return {
              ...current,
              validation: { phase: 'rejected', report: message.report, source: current.validation?.source ?? pendingSourceRef.current },
              notice: undefined,
            };
          case 'round-state':
            return { ...current, round: message.state };
          case 'presentation':
            return { ...current, presentation: message.state };
          case 'leaderboard':
            return { ...current, leaderboard: message.entries };
          case 'driver-status':
            return { ...current, statusByVersion: { ...current.statusByVersion, [message.version]: message } };
          case 'error':
            return { ...current, notice: message.message };
          default:
            return current;
        }
      });
    };
    const connection = new RoomConnection<ServerToPlayerMessage, PlayerToServerMessage>(
      roomSocketUrl(session.roomCode, { role: 'player', playerId: session.playerId, token: session.playerToken }),
      handleMessage,
      (status) => setState((current) => ({ ...current, connection: status })),
    );
    connectionRef.current = connection;
    return () => connection.close();
  }, [session]);

  const submit = useCallback((source: string) => {
    pendingSourceRef.current = source;
    if (!connectionRef.current?.send({ type: 'submit', source })) {
      setState((current) => ({ ...current, notice: 'Not connected. Try again in a moment.' }));
    }
  }, []);

  // Scoped to the room, so a push applied during a rehearsal still applies in the real talk.
  const settingsPush = useMemo(() => {
    const push = settingsFromPush(state.presentation.settingsPush);
    return push ? { ...push, id: `${session.roomCode}:${push.id}` } : undefined;
  }, [state.presentation.settingsPush, session.roomCode]);

  const renderTopBar = useCallback(
    (context: AppTopBarContext) => <RaceBar session={session} state={state} context={context} onSubmit={submit} onLeave={onLeave} />,
    [session, state, submit, onLeave],
  );

  return (
    <App
      renderTopBar={renderTopBar}
      examples={ROOM_EXAMPLES}
      storageNamespace={ROOM_STORAGE_NAMESPACE}
      lockedHelpers={state.presentation.lockedHelpers}
      catchUp={checkpointExamples.find((example) => example.id === state.presentation.checkpointId)}
      settingsPush={settingsPush}
    />
  );
}

function RaceBar({
  session,
  state,
  context,
  onSubmit,
  onLeave,
}: {
  session: PlayerSession;
  state: RoomState;
  context: AppTopBarContext;
  onSubmit: (source: string) => void;
  onLeave: () => void;
}) {
  const [, forceTick] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const rank = state.leaderboard.findIndex((entry) => entry.playerId === session.playerId);
  const entry = rank >= 0 ? state.leaderboard[rank] : undefined;
  const connected = state.connection === 'open';
  const unchanged = state.submittedSource !== undefined && state.submittedSource === context.code;
  const validating = state.validation?.phase === 'validating';
  // Test drives are seeded from the code, so resubmitting rejected code would only fail again.
  // Server hiccups (the test drive couldn't run or ran out of time) are worth retrying with the same code.
  const rejectedUnchanged =
    state.validation?.phase === 'rejected' &&
    state.validation.source === context.code &&
    !state.validation.report.issues.some((issue) => issue.check === 'unavailable' || issue.check === 'timeout');
  const submissionsOpen = state.presentation.submissionsOpen;
  const status = submissionsOpen ? describeStatus(state, session.playerId) : undefined;
  const secondsLeft = state.round.endsAt ? Math.max(0, Math.ceil((state.round.endsAt - Date.now()) / 1000)) : undefined;

  return (
    <div className="relative z-30 border-b border-border bg-card px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Flag className="size-4" />
          <span className="font-mono text-base font-semibold tracking-[0.2em]">{session.roomCode}</span>
          <span className="text-muted-foreground">as</span>
          <span className="font-semibold">{session.name}</span>
          <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>● {state.connection}</span>
        </div>

        <div className="text-muted-foreground">
          {state.round.phase === 'racing'
            ? `Round ${state.round.round} racing${secondsLeft !== undefined ? ` · ${secondsLeft}s left` : ''}`
            : state.round.phase === 'intermission'
              ? `Next round in ${secondsLeft ?? '?'}s`
              : 'Waiting for the host to start'}
        </div>

        {entry ? (
          <div className="flex items-center gap-1.5">
            <Trophy className="size-4 text-amber-300" />
            <span className="font-semibold">#{rank + 1}</span>
            <span className="text-muted-foreground">
              {entry.totalPoints} pts
              {entry.lastRound
                ? ` · last round ${entry.lastRound.points} (${entry.lastRound.distance} m, ${entry.lastRound.atFaultCollisions} at fault, ${entry.lastRound.edgeHits} edge hits, place ${entry.lastRound.place}/${entry.lastRound.finishedRacers})`
                : ''}
            </span>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {submissionsOpen ? (
            <>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => context.applySettings(raceSettings(0, DEFAULT_RACE_CONFIG.trafficDensity))}
                title="Noise on, assists off, race traffic density and starting speed"
              >
                Practice with race settings
              </button>
              <div className="group relative">
                <Button
                  type="button"
                  size="sm"
                  variant={rejectedUnchanged ? 'destructive' : 'default'}
                  disabled={!connected || !context.codeReady || context.assistsOn || unchanged || validating || rejectedUnchanged}
                  onClick={() => onSubmit(context.code)}
                  aria-describedby="submission-validation"
                >
                  {validating ? <Loader2 className="animate-spin" /> : rejectedUnchanged ? <XCircle /> : <Send />}
                  {validating
                    ? 'Validating…'
                    : rejectedUnchanged
                      ? 'Not accepted'
                      : unchanged
                        ? `Submitted v${state.submittedVersion}`
                        : state.submittedVersion
                          ? 'Submit new version'
                          : 'Submit to race'}
                </Button>
                <ValidationPopover
                  validation={state.validation}
                  racingVersion={state.submittedVersion}
                  blockedReason={
                    !context.codeReady
                      ? 'Fix the compile errors in the editor first.'
                      : context.assistsOn
                        ? 'Turn off steer and accelerate assist first: races run without them.'
                        : undefined
                  }
                />
              </div>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Racing opens later in the talk. Practice here until then.</span>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onLeave} title="Leave room">
            <LogOut />
          </Button>
        </div>
      </div>

      {context.assistsOn && submissionsOpen ? (
        <div className="mt-1 text-xs text-amber-400">
          Assists are on, so your code isn't fully driving. Races run with assists off: turn them off (or use{' '}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => context.applySettings(raceSettings(0, DEFAULT_RACE_CONFIG.trafficDensity))}
          >
            race settings
          </button>
          ) and test before submitting.
        </div>
      ) : null}
      {state.connection === 'unreachable' ? (
        <div className="mt-1 text-xs text-red-400">
          Can't reach room {session.roomCode}. It may have closed. Leave and join the presenter's current code.
        </div>
      ) : null}
      {status || state.notice ? (
        <div className="mt-1 flex items-start gap-2 text-xs">
          <span className={status?.tone === 'error' || state.notice ? 'text-red-400' : 'text-muted-foreground'}>
            {state.notice ?? status?.summary}
          </span>
          {status?.details ? (
            <button type="button" className="underline-offset-4 hover:underline" onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen ? 'hide details' : 'details'}
            </button>
          ) : null}
        </div>
      ) : null}
      {detailsOpen && status?.details ? (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-xs text-red-300">{status.details}</pre>
      ) : null}
      <div className="mt-1 text-[11px] text-muted-foreground">
        Score: meters driven − {RACE_SCORING.atFaultPenalty} per crash you cause − {RACE_SCORING.involvedPenalty} per crash you are
        in − {RACE_SCORING.edgeHitPenalty} per road-edge hit. Your latest submitted version keeps racing until you submit another.
      </div>
    </div>
  );
}

function describeStatus(
  state: RoomState,
  playerId: string,
): { summary: string; details?: string; tone: 'info' | 'error' } | undefined {
  const version = state.submittedVersion;
  const keepsRacing = version ? ` Version ${version} keeps racing.` : '';
  if (state.validation?.phase === 'validating') {
    const queue = state.validation.queuedBehind > 0 ? ` (waiting for ${state.validation.queuedBehind} ahead)` : '';
    return { summary: `Test-driving your code before it can race${queue}… Hover the button for details.`, tone: 'info' };
  }
  if (state.validation?.phase === 'rejected') {
    const [first, ...rest] = state.validation.report.issues;
    return {
      summary: `Not accepted: ${first?.message.split('\n')[0] ?? 'the test drive failed.'}${keepsRacing}`,
      details: [...(first?.message.split('\n').slice(1) ?? []), ...rest.map((issue) => issue.message)].join('\n') || undefined,
      tone: 'error',
    };
  }
  if (!version) return { summary: 'Write a driver, test it here, then submit it to race.', tone: 'info' };
  const racingVersion = state.round.phase === 'racing' ? state.round.racingVersions?.[playerId] : undefined;
  const racingNote = racingVersion && racingVersion !== version ? ` Version ${racingVersion} is racing this round.` : '';
  const update = state.statusByVersion[version];
  if (!update) return { summary: `Version ${version} sent. Waiting for the presenter to compile it…${racingNote}`, tone: 'info' };

  const [firstLine, ...rest] = (update.message ?? '').split('\n');
  switch (update.status) {
    case 'error':
      return {
        summary: `${firstLine || 'Your driver hit an error.'}${racingNote}`,
        details: rest.join('\n') || undefined,
        tone: 'error',
      };
    case 'racing':
      return { summary: `Racing version ${version} now. Watch the big screen!`, tone: 'info' };
    case 'queued':
      return { summary: `Version ${version} compiled. It takes over next round.${racingNote}`, tone: 'info' };
    case 'ready':
      return { summary: `Version ${version} is ready for the next round.`, tone: 'info' };
  }
}

function ValidationPopover({
  validation,
  racingVersion,
  blockedReason,
}: {
  validation?: ValidationState;
  racingVersion?: number;
  /** Why the button is disabled before submitting, if it is. */
  blockedReason?: string;
}) {
  const rules = VALIDATION_RULES;
  let icon = <ShieldCheck className="size-4 text-sky-300" />;
  let title = 'Every submission is test-driven first';
  let body: JSX.Element;

  if (validation?.phase === 'validating') {
    icon = <Loader2 className="size-4 animate-spin text-sky-300" />;
    title = 'Test-driving your code';
    body = (
      <>
        <p>
          The server is running your driver on its own for {rules.simulatedSeconds} s in race traffic. This usually takes a few
          seconds.
        </p>
        {validation.queuedBehind > 0 ? (
          <p className="mt-1 text-amber-300">Waiting for {validation.queuedBehind} other test drive(s) to finish first.</p>
        ) : null}
        <RuleList />
      </>
    );
  } else if (validation?.phase === 'passed') {
    icon = <CheckCircle2 className="size-4 text-emerald-400" />;
    title = `Version ${validation.version} passed its test drive`;
    body = (
      <>
        <MetricTable report={validation.report} />
        <p className="mt-2">It races from the start of the next round.</p>
      </>
    );
  } else if (validation?.phase === 'rejected') {
    icon = <XCircle className="size-4 text-red-400" />;
    title = 'Not accepted for the race';
    body = (
      <>
        <ul className="grid gap-1.5">
          {validation.report.issues.map((issue) => (
            <li key={issue.check} className="whitespace-pre-wrap text-red-300">
              {issue.message}
            </li>
          ))}
        </ul>
        {validation.report.metrics ? <MetricTable report={validation.report} /> : null}
        <p className="mt-2">
          {racingVersion ? `Version ${racingVersion} keeps racing. ` : 'Nothing is racing for you yet. '}
          Change your code and submit again.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p>
          Before your code races, the server drives it on its own for {rules.simulatedSeconds} s in race traffic. Some
          bumps and slow patches are fine.
        </p>
        <RuleList />
        {blockedReason ? <p className="mt-2 text-amber-300">{blockedReason}</p> : null}
      </>
    );
  }

  return (
    <div
      id="submission-validation"
      role="tooltip"
      className="pointer-events-none absolute right-0 top-[calc(100%+0.5rem)] z-40 hidden w-80 rounded-md border border-input bg-popover p-3 text-left font-sans text-xs leading-relaxed text-popover-foreground shadow-xl shadow-black/50 group-focus-within:block group-hover:block"
    >
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      {body}
    </div>
  );
}

function RuleList() {
  const rules = VALIDATION_RULES;
  return (
    <>
      <p className="mt-2 text-muted-foreground">A submission is rejected if it would spoil the race for others:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
        <li>
          crawling or stopped (under {kmh(rules.blockingSpeed)}) with no slower car close ahead for more than{' '}
          {percent(rules.maxBlockingFraction)} of the drive
        </li>
        <li>causing more than {rules.maxAtFaultCollisions} crashes</li>
        <li>erroring or timing out for a whole second</li>
      </ul>
    </>
  );
}

function MetricTable({ report }: { report: ValidationReport }) {
  const metrics = report.metrics;
  if (!metrics) return null;
  const rules = VALIDATION_RULES;
  const rows: { label: string; value: string; limit?: string; failed: boolean }[] = [
    { label: 'Average speed', value: kmh(metrics.averageSpeed), failed: false },
    {
      label: 'Slow, not held up',
      value: percent(metrics.blockingFraction),
      limit: `max ${percent(rules.maxBlockingFraction)}`,
      failed: metrics.blockingFraction > rules.maxBlockingFraction,
    },
    {
      label: 'Crashes caused',
      value: String(metrics.atFaultCollisions),
      limit: `max ${rules.maxAtFaultCollisions}`,
      failed: metrics.atFaultCollisions > rules.maxAtFaultCollisions,
    },
    { label: 'Distance', value: `${Math.round(metrics.distance)} m in ${Math.round(metrics.simulatedSeconds)} s`, failed: false },
  ];
  if (metrics.failedSteps > 0) rows.push({ label: 'Steps that errored', value: String(metrics.failedSteps), failed: false });
  return (
    <table className="mt-2 w-full border-t border-border pt-1 tabular-nums">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td className="py-0.5 pr-2 text-muted-foreground">{row.label}</td>
            <td className={`py-0.5 text-right ${row.failed ? 'text-red-400' : 'text-foreground'}`}>{row.value}</td>
            <td className="w-16 py-0.5 pl-2 text-right text-[11px] text-muted-foreground">{row.limit ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
