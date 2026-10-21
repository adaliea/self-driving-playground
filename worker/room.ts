import { DurableObject } from 'cloudflare:workers';
import {
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
  type RoundState,
  type ServerToHostMessage,
  type ServerToPlayerMessage,
} from '../src/multiplayer/protocol';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

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
}

/**
 * One room per Durable Object. Stores players and their latest driver source, relays submissions to
 * host connections only, and relays host-computed round state and leaderboards to players.
 */
export class Room extends DurableObject<Env> {
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
    if (attachment.role === 'host') {
      const players = await this.players();
      send(server, {
        type: 'room',
        roomCode: meta.roomCode,
        players: [...players.values()].map((candidate) => this.summary(candidate)),
        round,
        leaderboard: (await this.ctx.storage.get<LeaderboardEntry[]>('leaderboard')) ?? [],
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
        version: player.version || undefined,
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
    if (new TextEncoder().encode(message.source).byteLength > MAX_SOURCE_BYTES) {
      send(socket, { type: 'error', message: `Driver code must be under ${MAX_SOURCE_BYTES / 1024} KB.` });
      return;
    }
    const now = Date.now();
    if (player.submittedAt !== undefined && now - player.submittedAt < MIN_SUBMIT_INTERVAL_MS) {
      send(socket, { type: 'error', message: 'Slow down: wait a few seconds between submissions.' });
      return;
    }

    player.version += 1;
    player.submittedAt = now;
    player.source = message.source;
    await this.savePlayer(player);
    await this.touch();
    send(socket, { type: 'submission-accepted', version: player.version, submittedAt: now });
    this.broadcastToHosts({ type: 'submission', playerId, version: player.version, submittedAt: now, source: message.source });
    this.broadcastToHosts({ type: 'player', player: this.summary(player) });
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
