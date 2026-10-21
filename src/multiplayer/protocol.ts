// Wire protocol shared by the room Durable Object, the host (presenter) view, and player clients.
// The host is authoritative: it runs every submitted driver and computes scores. The room server
// only relays code to hosts and results back to players, so it never executes user code.

export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_PLAYER_NAME_LENGTH = 24;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = MAX_SOURCE_BYTES + 4 * 1024;
export const MIN_SUBMIT_INTERVAL_MS = 3000;
export const MAX_PLAYERS_PER_ROOM = 40;

export type RoundPhase = 'lobby' | 'racing' | 'intermission';

export interface RoundState {
  phase: RoundPhase;
  round: number;
  /** Epoch milliseconds when the current phase ends, if timed. */
  endsAt?: number;
  /** Driver version each player is racing with in the current round. */
  racingVersions?: Record<string, number>;
}

export interface PlayerSummary {
  id: string;
  name: string;
  connected: boolean;
  /** Latest submitted driver version, if any. */
  version?: number;
  submittedAt?: number;
}

export interface RoundResult {
  round: number;
  distance: number;
  collisions: number;
  atFaultCollisions: number;
  points: number;
  place: number;
  finishedRacers: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  totalPoints: number;
  bestRoundPoints: number;
  roundsRaced: number;
  totalAtFault: number;
  lastRound?: RoundResult;
}

export type DriverStatus = 'queued' | 'ready' | 'racing' | 'error';

export interface DriverStatusUpdate {
  playerId: string;
  version: number;
  status: DriverStatus;
  message?: string;
}

// ---- Player -> server ----
export type PlayerToServerMessage = { type: 'submit'; source: string } | { type: 'ping' };

// ---- Host -> server ----
export type HostToServerMessage =
  | { type: 'round-state'; state: RoundState }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | ({ type: 'driver-status' } & DriverStatusUpdate)
  | { type: 'ping' };

// ---- Server -> player ----
export type ServerToPlayerMessage =
  | { type: 'welcome'; playerId: string; name: string; roomCode: string; round: RoundState; version?: number }
  | { type: 'submission-accepted'; version: number; submittedAt: number }
  | { type: 'round-state'; state: RoundState }
  | { type: 'leaderboard'; entries: LeaderboardEntry[] }
  | ({ type: 'driver-status' } & DriverStatusUpdate)
  | { type: 'error'; message: string }
  | { type: 'pong' };

// ---- Server -> host ----
export type ServerToHostMessage =
  | {
      type: 'room';
      roomCode: string;
      players: PlayerSummary[];
      round: RoundState;
      leaderboard: LeaderboardEntry[];
    }
  | { type: 'player'; player: PlayerSummary }
  | { type: 'submission'; playerId: string; version: number; submittedAt: number; source: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface CreateRoomResponse {
  roomCode: string;
  hostToken: string;
}

export interface JoinRoomRequest {
  name: string;
  playerId?: string;
  playerToken?: string;
}

export interface JoinRoomResponse {
  playerId: string;
  playerToken: string;
  name: string;
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false;
  for (const character of value) if (!ROOM_CODE_ALPHABET.includes(character)) return false;
  return true;
}

export function sanitizePlayerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Strip control and bidi-override characters so names cannot spoof the presenter screen.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('');
  return name.length > 0 ? name : undefined;
}

export function parsePlayerMessage(value: unknown): PlayerToServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'ping') return { type: 'ping' };
  if (value.type === 'submit' && typeof value.source === 'string') return { type: 'submit', source: value.source };
  return undefined;
}

export function parseHostMessage(value: unknown): HostToServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'ping':
      return { type: 'ping' };
    case 'round-state': {
      const state = parseRoundState(value.state);
      return state ? { type: 'round-state', state } : undefined;
    }
    case 'leaderboard': {
      if (!Array.isArray(value.entries) || value.entries.length > MAX_PLAYERS_PER_ROOM) return undefined;
      const entries = value.entries.map(parseLeaderboardEntry);
      return entries.every(Boolean) ? { type: 'leaderboard', entries: entries as LeaderboardEntry[] } : undefined;
    }
    case 'driver-status': {
      const status = value.status;
      if (
        typeof value.playerId !== 'string' ||
        !isFiniteNumber(value.version) ||
        (status !== 'queued' && status !== 'ready' && status !== 'racing' && status !== 'error')
      ) {
        return undefined;
      }
      return {
        type: 'driver-status',
        playerId: value.playerId,
        version: value.version,
        status,
        message: typeof value.message === 'string' ? value.message.slice(0, 2000) : undefined,
      };
    }
    default:
      return undefined;
  }
}

function parseRoundState(value: unknown): RoundState | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.round)) return undefined;
  if (value.phase !== 'lobby' && value.phase !== 'racing' && value.phase !== 'intermission') return undefined;
  let racingVersions: Record<string, number> | undefined;
  if (isRecord(value.racingVersions)) {
    racingVersions = {};
    for (const [id, version] of Object.entries(value.racingVersions).slice(0, MAX_PLAYERS_PER_ROOM)) {
      if (isFiniteNumber(version)) racingVersions[id] = version;
    }
  }
  return {
    phase: value.phase,
    round: value.round,
    endsAt: isFiniteNumber(value.endsAt) ? value.endsAt : undefined,
    racingVersions,
  };
}

function parseRoundResult(value: unknown): RoundResult | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ['round', 'distance', 'collisions', 'atFaultCollisions', 'points', 'place', 'finishedRacers'] as const;
  if (!fields.every((field) => isFiniteNumber(value[field]))) return undefined;
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as RoundResult;
}

function parseLeaderboardEntry(value: unknown): LeaderboardEntry | undefined {
  if (!isRecord(value) || typeof value.playerId !== 'string') return undefined;
  const name = sanitizePlayerName(value.name);
  const numbers = ['totalPoints', 'bestRoundPoints', 'roundsRaced', 'totalAtFault'] as const;
  if (!name || !numbers.every((field) => isFiniteNumber(value[field]))) return undefined;
  const lastRound = value.lastRound === undefined ? undefined : parseRoundResult(value.lastRound);
  if (value.lastRound !== undefined && !lastRound) return undefined;
  return {
    playerId: value.playerId,
    name,
    totalPoints: value.totalPoints as number,
    bestRoundPoints: value.bestRoundPoints as number,
    roundsRaced: value.roundsRaced as number,
    totalAtFault: value.totalAtFault as number,
    lastRound,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
