import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  type CreateRoomResponse,
  type JoinRoomRequest,
} from '../src/multiplayer/protocol';
import type { Env } from './room';

export { Room } from './room';

const ROOM_ROUTE = /^\/api\/rooms\/([A-Za-z0-9]+)\/(join|ws)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/rooms' && request.method === 'POST') return createRoom(env);

    const match = ROOM_ROUTE.exec(url.pathname);
    if (!match) return json({ error: 'Not found.' }, 404);
    const roomCode = normalizeRoomCode(match[1]);
    if (!isValidRoomCode(roomCode)) return json({ error: 'Invalid room code.' }, 400);
    const room = env.ROOMS.get(env.ROOMS.idFromName(roomCode));

    if (match[2] === 'ws') return room.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    let body: JoinRoomRequest;
    try {
      body = (await request.json()) as JoinRoomRequest;
    } catch {
      return json({ error: 'Invalid request.' }, 400);
    }
    const result = await room.join({
      name: String(body?.name ?? ''),
      playerId: typeof body?.playerId === 'string' ? body.playerId : undefined,
      playerToken: typeof body?.playerToken === 'string' ? body.playerToken : undefined,
    });
    return 'error' in result ? json({ error: result.error }, result.status) : json(result);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomCode = randomRoomCode();
    const hostToken = await env.ROOMS.get(env.ROOMS.idFromName(roomCode)).initialize(roomCode);
    if (hostToken) return json({ roomCode, hostToken } satisfies CreateRoomResponse, 201);
  }
  return json({ error: 'Could not allocate a room code.' }, 503);
}

function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
