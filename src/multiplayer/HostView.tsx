import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CARTOON_FONT, CartoonRenderer, type CartoonPlayerLabel } from '../rendering';
import { RoomConnection, createRoom, readStoredJson, roomSocketUrl, writeStoredJson, type ConnectionStatus } from './connection';
import type { CreateRoomResponse, HostToServerMessage, LeaderboardEntry, RoundPhase, ServerToHostMessage } from './protocol';
import { RaceEngine, type DriverView, type LiveStanding, type RaceConfig } from './RaceEngine';
import { RACE_SCORING } from './scoring';

const HOST_SESSION_KEY = 'self-driving-playground:host-session:v1';
const UI_REFRESH_MS = 250;
const PACK_WINDOW_METERS = 180;
const MIN_SCALE = 5;
const MAX_SCALE = 13;
const BACKLOG_FRAME_SKIP_SECONDS = 0.08;
const MAX_SKIPPED_FRAMES = 2;

const ink = '#1d1b2e';
const panel = 'rounded-2xl border-[3px] border-[#1d1b2e] bg-white shadow-[4px_4px_0_#1d1b2e]';
const fontStyle: CSSProperties = { fontFamily: CARTOON_FONT };

interface HostUiState {
  phase: RoundPhase;
  round: number;
  paused: boolean;
  timeRemaining: number;
  drivers: DriverView[];
  standings: LiveStanding[];
  leaderboard: LeaderboardEntry[];
  lastResults: { playerId: string; name: string; color: string; points: number; distance: number; atFault: number; collisions: number }[];
  progress: { playerId: string; name: string; color: string; distance: number }[];
}

const initialUi: HostUiState = {
  phase: 'lobby',
  round: 0,
  paused: false,
  timeRemaining: 0,
  drivers: [],
  standings: [],
  leaderboard: [],
  lastResults: [],
  progress: [],
};

export function HostView() {
  const [session, setSession] = useState<CreateRoomResponse | undefined>(() => readStoredJson(HOST_SESSION_KEY));
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string>();
  const [ui, setUi] = useState<HostUiState>(initialUi);
  const [config, setConfig] = useState<RaceConfig>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RaceEngine>();
  const connectionRef = useRef<RoomConnection<ServerToHostMessage, HostToServerMessage>>();

  const startNewRoom = useCallback(async () => {
    setError(undefined);
    try {
      const created = await createRoom();
      writeStoredJson(HOST_SESSION_KEY, created);
      setSession(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const autoCreateTried = useRef(false);
  useEffect(() => {
    // Guarded so React StrictMode's double effect run does not create two rooms.
    if (session || autoCreateTried.current) return;
    autoCreateTried.current = true;
    void startNewRoom();
  }, [session, startNewRoom]);

  useEffect(() => {
    if (!session) return undefined;
    let restored = false;
    const send = (message: HostToServerMessage) => connectionRef.current?.send(message);
    const engine = new RaceEngine({
      onDriverStatus: (update) => send({ type: 'driver-status', ...update }),
      onRoundState: (state) => send({ type: 'round-state', state }),
      onLeaderboard: (entries) => send({ type: 'leaderboard', entries }),
    });
    engineRef.current = engine;
    setConfig({ ...engine.config });

    const handleMessage = (message: ServerToHostMessage) => {
      switch (message.type) {
        case 'room':
          for (const player of message.players) engine.upsertPlayer(player);
          if (!restored) {
            restored = true;
            engine.restore(message.round, message.leaderboard);
            engine.enterLobby();
          } else {
            engine.resync();
          }
          break;
        case 'player':
          engine.upsertPlayer(message.player);
          break;
        case 'submission':
          void engine.submit(message.playerId, message.version, message.source);
          break;
        case 'error':
          setError(message.message);
          break;
      }
    };
    const roomConnection = new RoomConnection<ServerToHostMessage, HostToServerMessage>(
      roomSocketUrl(session.roomCode, { role: 'host', token: session.hostToken }),
      handleMessage,
      setConnection,
    );
    connectionRef.current = roomConnection;

    return () => {
      roomConnection.close();
      engine.dispose();
      connectionRef.current = undefined;
      engineRef.current = undefined;
    };
  }, [session]);

  // Simulation loop, separate from rendering so slow frames do not slow the race clock.
  useEffect(() => {
    let disposed = false;
    let previous = performance.now();
    const loop = async () => {
      while (!disposed) {
        const now = performance.now();
        const elapsed = (now - previous) / 1000;
        previous = now;
        await engineRef.current?.tick(elapsed);
        await new Promise((resolve) => window.setTimeout(resolve, 4));
      }
    };
    void loop();
    return () => {
      disposed = true;
    };
  }, []);

  // Render loop.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderer = new CartoonRenderer(canvas);
    const observer = new ResizeObserver(() => renderer.resize());
    observer.observe(canvas);
    const camera = { centerS: 0, scale: 9, round: -1 };
    let previous = performance.now();
    let frame = 0;
    let skipped = 0;

    const loop = (now: number) => {
      const elapsed = Math.max(0, (now - previous) / 1000);
      previous = now;
      const engine = engineRef.current;
      // When drivers are falling behind real time, drop frames to free the main thread for them.
      if (engine && engine.backlogSeconds > BACKLOG_FRAME_SKIP_SECONDS && skipped < MAX_SKIPPED_FRAMES) {
        skipped += 1;
        frame = requestAnimationFrame(loop);
        return;
      }
      skipped = 0;
      const states = engine?.playerStates() ?? [];
      if (!engine || states.length === 0) {
        renderer.renderIdle(now / 1000);
      } else {
        const leaderS = Math.max(...states.map((state) => state.s));
        const packMinS = Math.min(...states.filter((state) => state.s > leaderS - PACK_WINDOW_METERS).map((state) => state.s));
        const span = leaderS - packMinS + 70;
        const targetCenter = (packMinS + leaderS) / 2 + 12;
        const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (renderer.viewportWidth * 0.82) / span));
        const snap = camera.round !== engine.round;
        const blend = snap ? 1 : Math.min(1, elapsed * 2.5);
        camera.round = engine.round;
        camera.centerS += (targetCenter - camera.centerS) * blend;
        camera.scale += (targetScale - camera.scale) * blend;
        const half = renderer.viewportWidth / 2 / camera.scale + 30;
        const snapshot = engine.snapshot({ centerS: camera.centerS, behindMeters: half, aheadMeters: half });
        if (snapshot) {
          const standings = engine.liveStandings();
          const players = new Map<string, CartoonPlayerLabel>(
            standings.map((standing, index) => [
              standing.playerId,
              { name: standing.name, color: standing.color, place: index + 1, stalled: standing.stalled },
            ]),
          );
          renderer.render({ snapshot, scale: camera.scale, players, atFaultPenalty: RACE_SCORING.atFaultPenalty, time: now / 1000 });
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Low-frequency UI refresh for overlays.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const standings = engine.liveStandings();
      setUi({
        phase: engine.phase,
        round: engine.round,
        paused: engine.paused,
        timeRemaining: engine.timeRemaining,
        drivers: engine.driverViews(),
        standings,
        leaderboard: engine.leaderboard,
        lastResults: [...engine.lastResults.entries()]
          .map(([playerId, result]) => ({
            playerId,
            name: engine.playerName(playerId) ?? 'Driver',
            color: engine.playerColor(playerId),
            points: result.points,
            distance: result.distance,
            atFault: result.atFaultCollisions,
            collisions: result.collisions,
          }))
          .sort((a, b) => b.points - a.points),
        progress: standings.map(({ playerId, name, color, distance }) => ({ playerId, name, color, distance })),
      });
    }, UI_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const updateConfig = (patch: Partial<RaceConfig>) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.config = { ...engine.config, ...patch };
    setConfig({ ...engine.config });
  };

  const joinUrl = session ? `${window.location.origin}/play/${session.roomCode}` : '';
  const readyCount = ui.drivers.filter((driver) => driver.readyVersion !== undefined).length;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#7fd35a] text-[#1d1b2e]" style={fontStyle}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Room code badge */}
      <div className={`absolute left-4 top-4 px-4 py-2 ${panel}`}>
        <div className="text-xs font-black uppercase tracking-widest opacity-60">Join at {window.location.host}/play</div>
        <div className="text-4xl font-black tracking-[0.2em]">{session?.roomCode ?? '·····'}</div>
        {connection !== 'open' ? <div className="text-xs font-bold text-[#ef233c]">{connection}…</div> : null}
      </div>

      {/* Round timer */}
      {ui.phase !== 'lobby' ? (
        <div className={`absolute left-1/2 top-4 -translate-x-1/2 px-6 py-2 text-center ${panel}`}>
          <div className="text-xs font-black uppercase tracking-widest opacity-60">
            {ui.phase === 'racing' ? `Round ${ui.round}` : `Next round in`}
            {ui.paused ? ' · paused' : ''}
          </div>
          <div className="text-4xl font-black tabular-nums">{formatClock(ui.timeRemaining)}</div>
        </div>
      ) : null}

      {/* Standings */}
      <div className="absolute bottom-24 right-4 top-4 flex w-[22rem] flex-col gap-3">
        {ui.phase === 'racing' ? (
          <Panel title={`Round ${ui.round} · live`}>
            {ui.standings.map((standing, index) => (
              <Row
                key={standing.playerId}
                place={index + 1}
                color={standing.color}
                name={standing.name}
                detail={`${Math.round(standing.distance)} m${standing.atFaultCollisions ? ` · 💥${standing.atFaultCollisions}` : ''}${standing.benched ? ' · benched' : ''}`}
                value={standing.points}
              />
            ))}
          </Panel>
        ) : null}
        <Panel title="Leaderboard">
          {ui.leaderboard.length === 0 ? (
            <div className="px-3 py-2 text-sm font-bold opacity-60">No rounds finished yet.</div>
          ) : (
            ui.leaderboard.slice(0, ui.phase === 'racing' ? 6 : 14).map((entry, index) => (
              <Row
                key={entry.playerId}
                place={index + 1}
                color={engineRef.current?.playerColor(entry.playerId) ?? '#ccc'}
                name={entry.name}
                detail={`best ${entry.bestRoundPoints} · ${entry.roundsRaced} rd${entry.totalAtFault ? ` · 💥${entry.totalAtFault}` : ''}`}
                value={entry.totalPoints}
              />
            ))
          )}
        </Panel>
        <div className={`px-3 py-2 text-xs font-bold ${panel}`}>
          Score = meters driven − {RACE_SCORING.atFaultPenalty} per crash you cause − {RACE_SCORING.involvedPenalty} per crash
          you're in. Causing a crash also stalls your car for {RACE_SCORING.atFaultStallSeconds}s.
        </div>
      </div>

      {/* Progress strip */}
      {ui.phase === 'racing' && ui.progress.length > 0 ? <ProgressStrip progress={ui.progress} /> : null}

      {/* Lobby */}
      {ui.phase === 'lobby' ? (
        <div className="absolute inset-0 flex items-center justify-center pr-[23rem]">
          <div className={`w-[min(46rem,90vw)] p-8 text-center ${panel}`}>
            <div className="text-2xl font-black">Join the race! 🏁</div>
            <div className="mt-2 text-lg font-bold opacity-70">Open</div>
            <div className="text-3xl font-black text-[#3d8bff]">{joinUrl || '…'}</div>
            <div className="mt-2 text-lg font-bold opacity-70">or enter code</div>
            <div className="text-7xl font-black tracking-[0.25em]">{session?.roomCode ?? '·····'}</div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {ui.drivers.length === 0 ? <span className="font-bold opacity-60">Waiting for drivers…</span> : null}
              {ui.drivers.map((driver) => (
                <DriverChip key={driver.playerId} driver={driver} />
              ))}
            </div>
            <button
              type="button"
              disabled={readyCount === 0}
              onClick={() => void engineRef.current?.startRound()}
              className="mt-6 rounded-2xl border-[3px] border-[#1d1b2e] bg-[#ffd23f] px-8 py-3 text-2xl font-black shadow-[4px_4px_0_#1d1b2e] active:translate-y-0.5 disabled:opacity-40"
            >
              {readyCount === 0 ? 'Waiting for submitted drivers' : `Start race with ${readyCount} driver${readyCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      ) : null}

      {/* Intermission results */}
      {ui.phase === 'intermission' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1d1b2e]/30 pr-[23rem]">
          <div className={`w-[min(44rem,90vw)] p-6 ${panel}`}>
            <div className="text-center text-3xl font-black">Round {ui.round} results</div>
            <div className="mt-4 grid grid-cols-3 items-end gap-3">
              {[1, 0, 2].map((index) => {
                const result = ui.lastResults[index];
                if (!result) return <div key={index} />;
                const heights = ['h-40', 'h-28', 'h-20'];
                return (
                  <div key={result.playerId} className="text-center">
                    <div className="truncate text-lg font-black">{result.name}</div>
                    <div className="text-sm font-bold">{result.points} pts</div>
                    <div
                      className={`${heights[index]} mt-1 flex items-start justify-center rounded-t-xl border-[3px] border-[#1d1b2e] pt-2 text-4xl font-black`}
                      style={{ background: result.color }}
                    >
                      {index + 1}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 max-h-56 overflow-auto">
              {ui.lastResults.slice(3).map((result, index) => (
                <Row
                  key={result.playerId}
                  place={index + 4}
                  color={result.color}
                  name={result.name}
                  detail={`${result.distance} m${result.atFault ? ` · 💥${result.atFault} at fault` : ''}`}
                  value={result.points}
                />
              ))}
            </div>
            <div className="mt-4 text-center text-lg font-bold">
              Submit new code now. It races in {Math.ceil(ui.timeRemaining)}s!
            </div>
          </div>
        </div>
      ) : null}

      {/* Host controls */}
      <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
        {controlsOpen && config ? (
          <div className={`w-80 p-3 text-sm font-bold ${panel}`}>
            <label className="flex items-center justify-between gap-2 py-1">
              Round length (s)
              <input
                type="number"
                min={20}
                max={600}
                value={config.roundSeconds}
                onChange={(event) => updateConfig({ roundSeconds: clampInput(event.target.value, 20, 600, 90) })}
                className="w-20 rounded border-2 border-[#1d1b2e] px-1"
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Break between rounds (s)
              <input
                type="number"
                min={3}
                max={300}
                value={config.intermissionSeconds}
                onChange={(event) => updateConfig({ intermissionSeconds: clampInput(event.target.value, 3, 300, 12) })}
                className="w-20 rounded border-2 border-[#1d1b2e] px-1"
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Traffic {Math.round(config.trafficDensity * 100)}%
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.trafficDensity}
                onChange={(event) => updateConfig({ trafficDensity: Number(event.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-1">
              Auto-start next round
              <input type="checkbox" checked={config.autoAdvance} onChange={(event) => updateConfig({ autoAdvance: event.target.checked })} />
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {ui.phase === 'racing' ? (
                <>
                  <HostButton onClick={() => engineRef.current?.setPaused(!ui.paused)}>{ui.paused ? 'Resume' : 'Pause'}</HostButton>
                  <HostButton onClick={() => engineRef.current?.endRound()}>End round</HostButton>
                </>
              ) : (
                <HostButton onClick={() => void engineRef.current?.startRound()}>Start round</HostButton>
              )}
              <HostButton onClick={() => engineRef.current?.enterLobby()}>Lobby</HostButton>
              <HostButton
                onClick={() => {
                  if (window.confirm('Clear every score on the leaderboard?')) engineRef.current?.resetLeaderboard();
                }}
              >
                Reset scores
              </HostButton>
              <HostButton
                onClick={() => {
                  if (window.confirm('Close this room and open a new one with a new code?')) void startNewRoom();
                }}
              >
                New room
              </HostButton>
              <HostButton onClick={() => void document.documentElement.requestFullscreen?.()}>Fullscreen</HostButton>
            </div>
            {error ? <div className="mt-2 text-xs text-[#ef233c]">{error}</div> : null}
          </div>
        ) : null}
        <HostButton onClick={() => setControlsOpen((open) => !open)}>{controlsOpen ? 'Hide controls' : '⚙ Host controls'}</HostButton>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${panel}`}>
      <div className="border-b-[3px] border-[#1d1b2e] bg-[#ffd23f] px-3 py-1.5 text-lg font-black">{title}</div>
      <div className="min-h-0 overflow-auto py-1">{children}</div>
    </div>
  );
}

function Row({ place, color, name, detail, value }: { place: number; color: string; name: string; detail: string; value: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className="w-6 text-right text-lg font-black">{place === 1 ? '👑' : place}</span>
      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[#1d1b2e]" style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-black">{name}</span>
        <span className="block truncate text-xs font-bold opacity-60">{detail}</span>
      </span>
      <span className="text-lg font-black tabular-nums">{value}</span>
    </div>
  );
}

function DriverChip({ driver }: { driver: DriverView }) {
  const ready = driver.readyVersion !== undefined;
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border-[3px] border-[#1d1b2e] bg-white px-3 py-1 font-black"
      style={{ opacity: driver.connected || ready ? 1 : 0.5 }}
      title={driver.message}
    >
      <span className="h-3 w-3 rounded-full border-2 border-[#1d1b2e]" style={{ background: driver.color }} />
      {driver.name}
      <span>{driver.status === 'error' && !ready ? '⚠️' : ready ? '✅' : '⌨️'}</span>
    </span>
  );
}

function ProgressStrip({ progress }: { progress: HostUiState['progress'] }) {
  const max = Math.max(50, ...progress.map((entry) => entry.distance));
  return (
    <div className={`absolute bottom-4 left-4 right-[24rem] h-16 px-6 ${panel}`}>
      <div className="absolute left-6 right-6 top-1/2 h-2 -translate-y-1/2 rounded-full bg-[#1d1b2e]/15" />
      {progress.map((entry) => (
        <div
          key={entry.playerId}
          className="absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] border-[#1d1b2e] text-sm font-black transition-[left] duration-300 ease-linear"
          style={{ left: `calc(1.5rem + (100% - 3rem) * ${Math.max(0, entry.distance) / max})`, background: entry.color }}
          title={`${entry.name}: ${Math.round(entry.distance)} m`}
        >
          {initials(entry.name)}
        </div>
      ))}
      <div className="absolute right-3 top-1 text-xs font-black opacity-60">{Math.round(max)} m</div>
    </div>
  );
}

function HostButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border-[3px] border-[#1d1b2e] bg-white px-3 py-1.5 text-sm font-black shadow-[3px_3px_0_#1d1b2e] active:translate-y-0.5"
      style={{ color: ink }}
    >
      {children}
    </button>
  );
}

function initials(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function clampInput(value: string, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
