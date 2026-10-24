import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_PRESENTATION,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS_PER_ROOM,
  MAX_SOURCE_BYTES,
  MIN_SUBMIT_INTERVAL_MS,
  parseHostMessage,
  parsePlayerMessage,
  sanitizePlayerName,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LeaderboardEntry,
  type PlayerSummary,
  type PresentationState,
  type RoundState,
  type ServerToHostMessage,
  type ServerToPlayerMessage,
  type ValidationReport,
} from '../src/multiplayer/protocol';
import type { Validator } from './validator';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** Test drives running at once per room; later submissions wait their turn. */
const MAX_CONCURRENT_VALIDATIONS = 3;

interface RoomMeta {
  roomCode: string;
  hostTokenHash: string;
  createdAt: number;
}

interface StoredPlayer {
  id: string;
  name: string;
  tokenHash: string;
  version: number;
  submittedAt?: number;
  source?: string;
}

type SocketAttachment = { role: 'host' } | { role: 'player'; playerId: string };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  LOADER: WorkerLoader;
  /** "true" hides the join screen's "Practice on your own" link. Set it as a secret so deploys keep it. */
  HIDE_PRACTICE_LINK?: string;
}

/**
 * One room per Durable Object. Stores players and their latest driver source, relays submissions to
 * host connections only, and relays host-computed round state and leaderboards to players.
 */
export class Room extends DurableObject<Env> {
  // Validation bookkeeping is in memory: the object stays awake while a validation is in flight,
  // and losing it on eviction only forgets a pending test drive, which the player can resubmit.
  private readonly validating = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly validationQueue: (() => void)[] = [];
  private activeValidations = 0;

  /** Creates the room. Returns undefined if this code is already in use. */
  async initialize(roomCode: string): Promise<string | undefined> {
    if (await this.ctx.storage.get<RoomMeta>('meta')) return undefined;
    const hostToken = randomToken();
    await this.ctx.storage.put<RoomMeta>('meta', {
      roomCode,
      hostTokenHash: await sha256(hostToken),
      createdAt: Date.now(),
    });
    await this.touch();
    return hostToken;
  }

  async join(request: JoinRoomRequest): Promise<JoinRoomResponse | { error: string; status: number }> {
    if (!(await this.ctx.storage.get<RoomMeta>('meta'))) return { error: 'Room not found.', status: 404 };
    const requestedName = sanitizePlayerName(request.name);
    if (!requestedName) return { error: 'Enter a display name.', status: 400 };

    const players = await this.players();
    if (request.playerId && request.playerToken) {
      const existing = players.get(request.playerId);
      if (existing && existing.tokenHash === (await sha256(request.playerToken))) {
        existing.name = uniqueName(requestedName, players, existing.id);
        await this.savePlayer(existing);
        this.broadcastToHosts({ type: 'player', player: this.summary(existing) });
        return { playerId: existing.id, playerToken: request.playerToken, name: existing.name };
      }
    }

    if (players.size >= MAX_PLAYERS_PER_ROOM) return { error: 'This room is full.', status: 409 };
    const playerToken = randomToken();
    const player: StoredPlayer = {
      id: `p-${randomToken().slice(0, 10)}`,
      name: uniqueName(requestedName, players),
      tokenHash: await sha256(playerToken),
      version: 0,
    };
    await this.savePlayer(player);
    this.broadcastToHosts({ type: 'player', player: this.summary(player) });
    return { playerId: player.id, playerToken, name: player.name };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const meta = await this.ctx.storage.get<RoomMeta>('meta');
    if (!meta) return new Response('Room not found.', { status: 404 });

    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? '';
    const tokenHash = await sha256(token);
    let attachment: SocketAttachment;
    let player: StoredPlayer | undefined;

    if (url.searchParams.get('role') === 'host') {
      if (tokenHash !== meta.hostTokenHash) return new Response('Invalid host token.', { status: 403 });
      attachment = { role: 'host' };
    } else {
      player = (await this.players()).get(url.searchParams.get('playerId') ?? '');
      if (!player || player.tokenHash !== tokenHash) return new Response('Join the room first.', { status: 403 });
      attachment = { role: 'player', playerId: player.id };
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, attachment.role === 'host' ? ['host'] : ['player', attachment.playerId]);
    server.serializeAttachment(attachment);
    await this.touch();

    const round = await this.roundState();
    const presentation = await this.presentationState();
    if (attachment.role === 'host') {
      const players = await this.players();
      send(server, {
        type: 'room',
        roomCode: meta.roomCode,
        players: [...players.values()].map((candidate) => this.summary(candidate)),
        round,
        leaderboard: (await this.ctx.storage.get<LeaderboardEntry[]>('leaderboard')) ?? [],
        presentation,
      } satisfies ServerToHostMessage);
      for (const candidate of players.values()) {
        if (candidate.source && candidate.submittedAt !== undefined) {
          send(server, {
            type: 'submission',
            playerId: candidate.id,
            version: candidate.version,
            submittedAt: candidate.submittedAt,
            source: candidate.source,
          } satisfies ServerToHostMessage);
        }
      }
    } else if (player) {
      send(server, {
        type: 'welcome',
        playerId: player.id,
        name: player.name,
        roomCode: meta.roomCode,
        round,
        presentation,
        version: player.version || undefined,
        validating: this.validating.has(player.id) || undefined,
      } satisfies ServerToPlayerMessage);
      const leaderboard = await this.ctx.storage.get<LeaderboardEntry[]>('leaderboard');
      if (leaderboard) send(server, { type: 'leaderboard', entries: leaderboard } satisfies ServerToPlayerMessage);
      this.broadcastToHosts({ type: 'player', player: this.summary(player) });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    if (typeof raw !== 'string' || size > MAX_MESSAGE_BYTES) {
      send(socket, { type: 'error', message: 'Message too large.' });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const attachment = socket.deserializeAttachment() as SocketAttachment;
    if (attachment.role === 'host') await this.handleHostMessage(socket, data);
    else await this.handlePlayerMessage(socket, attachment.playerId, data);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role !== 'player') return;
    const player = (await this.players()).get(attachment.playerId);
    if (player) this.broadcastToHosts({ type: 'player', player: this.summary(player, socket) });
  }

  async alarm(): Promise<void> {
    const lastActivity = (await this.ctx.storage.get<number>('lastActivity')) ?? 0;
    if (Date.now() - lastActivity >= ROOM_TTL_MS && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  private async handlePlayerMessage(socket: WebSocket, playerId: string, data: unknown): Promise<void> {
    const message = parsePlayerMessage(data);
    if (!message) return;
    if (message.type === 'ping') {
      send(socket, { type: 'pong' });
      return;
    }

    const player = (await this.players()).get(playerId);
    if (!player) return;
    if (!(await this.presentationState()).submissionsOpen) {
      send(socket, { type: 'error', message: 'Racing has not opened yet. The presenter will open it soon.' });
      return;
    }
    if (new TextEncoder().encode(message.source).byteLength > MAX_SOURCE_BYTES) {
      send(socket, { type: 'error', message: `Driver code must be under ${MAX_SOURCE_BYTES / 1024} KB.` });
      return;
    }
    if (this.validating.has(playerId)) {
      send(socket, { type: 'error', message: 'Your last submission is still being test-driven.' });
      return;
    }
    const now = Date.now();
    const lastAttempt = this.lastAttemptAt.get(playerId) ?? player.submittedAt;
    if (lastAttempt !== undefined && now - lastAttempt < MIN_SUBMIT_INTERVAL_MS) {
      send(socket, { type: 'error', message: 'Slow down: wait a few seconds between submissions.' });
      return;
    }

    this.lastAttemptAt.set(playerId, now);
    this.validating.add(playerId);
    send(socket, { type: 'submission-validating', queuedBehind: Math.max(0, this.activeValidations + this.validationQueue.length - MAX_CONCURRENT_VALIDATIONS + 1) });
    // Not awaited: other messages keep flowing while the test drive runs.
    void this.validateSubmission(playerId, message.source).finally(() => this.validating.delete(playerId));
  }

  /** Test-drives a submission and, if it passes, makes it the player's racing version. */
  private async validateSubmission(playerId: string, source: string): Promise<void> {
    let report: ValidationReport;
    await this.acquireValidationSlot();
    try {
      const validator = (this.ctx.exports as unknown as { Validator: Service<Validator> }).Validator;
      report = await validator.validate(source, await this.validationSeed(source));
    } catch (error) {
      console.error('Validation failed to run', error);
      report = {
        passed: false,
        issues: [{ check: 'unavailable', message: 'The test drive could not run. Try submitting again in a moment.' }],
      };
    } finally {
      this.releaseValidationSlot();
    }

    if (!report.passed) {
      this.sendToPlayer(playerId, { type: 'submission-rejected', report });
      return;
    }
    const player = (await this.players()).get(playerId);
    if (!player) return;
    const now = Date.now();
    player.version += 1;
    player.submittedAt = now;
    player.source = source;
    await this.savePlayer(player);
    await this.touch();
    this.sendToPlayer(playerId, { type: 'submission-accepted', version: player.version, submittedAt: now, report });
    this.broadcastToHosts({ type: 'submission', playerId, version: player.version, submittedAt: now, source });
    this.broadcastToHosts({ type: 'player', player: this.summary(player) });
  }

  /**
   * Seeds the test drive from the room's secret and the source. Players can't predict the traffic
   * they will face, and resubmitting identical code gets the same verdict instead of another roll.
   */
  private async validationSeed(source: string): Promise<number> {
    const meta = await this.ctx.storage.get<RoomMeta>('meta');
    const digest = await sha256(`${meta?.hostTokenHash ?? ''}\n${source}`);
    return Number.parseInt(digest.slice(0, 8), 16);
  }

  private acquireValidationSlot(): Promise<void> {
    if (this.activeValidations < MAX_CONCURRENT_VALIDATIONS) {
      this.activeValidations += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.validationQueue.push(resolve));
  }

  private releaseValidationSlot(): void {
    const next = this.validationQueue.shift();
    if (next) next();
    else this.activeValidations -= 1;
  }

  private sendToPlayer(playerId: string, message: ServerToPlayerMessage): void {
    for (const socket of this.ctx.getWebSockets(playerId)) send(socket, message);
  }

  private async handleHostMessage(socket: WebSocket, data: unknown): Promise<void> {
    const message = parseHostMessage(data);
    if (!message) return;
    switch (message.type) {
      case 'ping':
        send(socket, { type: 'pong' });
        return;
      case 'round-state':
        await this.ctx.storage.put('round', message.state);
        this.broadcastToPlayers({ type: 'round-state', state: message.state });
        return;
      case 'leaderboard':
        await this.ctx.storage.put('leaderboard', message.entries);
        this.broadcastToPlayers({ type: 'leaderboard', entries: message.entries });
        return;
      case 'driver-status':
        for (const playerSocket of this.ctx.getWebSockets(message.playerId)) send(playerSocket, message);
        return;
      case 'presentation':
        await this.ctx.storage.put('presentation', message.state);
        this.broadcastToPlayers({ type: 'presentation', state: message.state });
        this.broadcastToHosts({ type: 'presentation', state: message.state });
        return;
    }
  }

  private async players(): Promise<Map<string, StoredPlayer>> {
    const entries = await this.ctx.storage.list<StoredPlayer>({ prefix: 'player:' });
    return new Map([...entries.values()].map((player) => [player.id, player]));
  }

  private async savePlayer(player: StoredPlayer): Promise<void> {
    await this.ctx.storage.put(`player:${player.id}`, player);
  }

  private async roundState(): Promise<RoundState> {
    return (await this.ctx.storage.get<RoundState>('round')) ?? { phase: 'lobby', round: 0 };
  }

  private async presentationState(): Promise<PresentationState> {
    // Rooms saved before a field existed get its default.
    return { ...DEFAULT_PRESENTATION, ...(await this.ctx.storage.get<PresentationState>('presentation')) };
  }

  private summary(player: StoredPlayer, closingSocket?: WebSocket): PlayerSummary {
    const connected = this.ctx.getWebSockets(player.id).some((socket) => socket !== closingSocket);
    return {
      id: player.id,
      name: player.name,
      connected,
      version: player.version || undefined,
      submittedAt: player.submittedAt,
    };
  }

  private broadcastToHosts(message: ServerToHostMessage): void {
    for (const socket of this.ctx.getWebSockets('host')) send(socket, message);
  }

  private broadcastToPlayers(message: ServerToPlayerMessage): void {
    for (const socket of this.ctx.getWebSockets('player')) send(socket, message);
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.put('lastActivity', Date.now());
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }
}

function send(socket: WebSocket, message: ServerToHostMessage | ServerToPlayerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between lookup and send.
  }
}

function uniqueName(name: string, players: Map<string, StoredPlayer>, selfId?: string): string {
  const taken = new Set([...players.values()].filter((player) => player.id !== selfId).map((player) => player.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name.slice(0, 20)} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
