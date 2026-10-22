import { Flag, LogOut, Send, Trophy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import App, { type AppTopBarContext } from '../App';
import { Button } from '../ui/Button';
import { RoomConnection, joinRoom, readStoredJson, roomSocketUrl, writeStoredJson, type ConnectionStatus } from './connection';
import {
  MAX_PLAYER_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  type DriverStatusUpdate,
  type JoinRoomResponse,
  type LeaderboardEntry,
  type PlayerToServerMessage,
  type RoundState,
  type ServerToPlayerMessage,
} from './protocol';
import { raceSettings, DEFAULT_RACE_CONFIG } from './RaceEngine';
import { RACE_SCORING } from './scoring';

const PLAYER_NAME_KEY = 'self-driving-playground:player-name:v1';
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
        writeStoredJson(playerSessionKey(session.roomCode), undefined);
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
        <a href="/" className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline">
          Back to solo playground
        </a>
      </form>
    </div>
  );
}

interface RoomState {
  connection: ConnectionStatus;
  round: RoundState;
  leaderboard: LeaderboardEntry[];
  submittedVersion?: number;
  submittedSource?: string;
  /** Latest presenter status for each submitted version. */
  statusByVersion: Record<number, DriverStatusUpdate>;
  notice?: string;
}

function PlayerRoom({ session, onLeave }: { session: PlayerSession; onLeave: () => void }) {
  const [state, setState] = useState<RoomState>({
    connection: 'connecting',
    round: { phase: 'lobby', round: 0 },
    leaderboard: [],
    statusByVersion: {},
  });
  const connectionRef = useRef<RoomConnection<ServerToPlayerMessage, PlayerToServerMessage>>();
  const pendingSourceRef = useRef<string>();

  useEffect(() => {
    const handleMessage = (message: ServerToPlayerMessage) => {
      setState((current) => {
        switch (message.type) {
          case 'welcome':
            return { ...current, round: message.round, submittedVersion: message.version ?? current.submittedVersion };
          case 'submission-accepted':
            return {
              ...current,
              submittedVersion: message.version,
              submittedSource: pendingSourceRef.current ?? current.submittedSource,
              notice: undefined,
            };
          case 'round-state':
            return { ...current, round: message.state };
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

  const renderTopBar = useCallback(
    (context: AppTopBarContext) => <RaceBar session={session} state={state} context={context} onSubmit={submit} onLeave={onLeave} />,
    [session, state, submit, onLeave],
  );

  return <App renderTopBar={renderTopBar} />;
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
  const status = describeStatus(state, session.playerId);
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
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => context.applySettings(raceSettings(0, DEFAULT_RACE_CONFIG.trafficDensity))}
            title="Noise on, assists off, race traffic density and starting speed"
          >
            Practice with race settings
          </button>
          <Button
            type="button"
            size="sm"
            disabled={!connected || !context.codeReady || context.assistsOn || unchanged}
            onClick={() => onSubmit(context.code)}
            title={
              !context.codeReady
                ? 'Fix compile errors first'
                : context.assistsOn
                  ? 'Turn off steer and accelerate assist first: races run without them'
                  : unchanged
                    ? 'This exact code is already submitted'
                    : undefined
            }
          >
            <Send />
            {unchanged ? `Submitted v${state.submittedVersion}` : state.submittedVersion ? 'Submit new version' : 'Submit to race'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onLeave} title="Leave room">
            <LogOut />
          </Button>
        </div>
      </div>

      {context.assistsOn ? (
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
