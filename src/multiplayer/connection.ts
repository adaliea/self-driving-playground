import type { CreateRoomResponse, JoinRoomRequest, JoinRoomResponse } from './protocol';

const PING_INTERVAL_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 8_000;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WebSocket wrapper that reconnects with backoff and keeps the socket alive with pings. */
export class RoomConnection<Incoming, Outgoing> {
  private socket?: WebSocket;
  private closed = false;
  private attempts = 0;
  private pingTimer?: number;
  private reconnectTimer?: number;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: Incoming) => void,
    private readonly onStatus: (status: ConnectionStatus, detail?: string) => void,
  ) {
    this.connect();
  }

  send(message: Outgoing): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.onStatus('closed');
  }

  private connect(): void {
    this.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.onStatus('open');
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' } as Outgoing), PING_INTERVAL_MS);
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        this.onMessage(JSON.parse(event.data) as Incoming);
      } catch {
        // Ignore malformed frames.
      }
    });
    socket.addEventListener('close', () => {
      window.clearInterval(this.pingTimer);
      if (this.closed || this.socket !== socket) return;
      this.attempts += 1;
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(this.attempts, 5));
      this.onStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    });
  }
}

export function roomSocketUrl(roomCode: string, params: Record<string, string>): string {
  const url = new URL(`/api/rooms/${roomCode}/ws`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export async function createRoom(): Promise<CreateRoomResponse> {
  return requestJson<CreateRoomResponse>('/api/rooms', {});
}

export async function joinRoom(roomCode: string, request: JoinRoomRequest): Promise<JoinRoomResponse> {
  return requestJson<JoinRoomResponse>(`/api/rooms/${roomCode}/join`, request);
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

export function readStoredJson<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors, such as private browsing restrictions.
  }
}
