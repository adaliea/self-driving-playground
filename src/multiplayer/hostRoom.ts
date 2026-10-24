import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomConnection, createRoom, readStoredJson, roomSocketUrl, writeStoredJson, type ConnectionStatus } from './connection';
import {
  DEFAULT_PRESENTATION,
  type CreateRoomResponse,
  type HostToServerMessage,
  type PlayerSummary,
  type PresentationState,
  type ServerToHostMessage,
} from './protocol';

/** Shared by /host and /presentation, so both control the same room. */
export const HOST_SESSION_KEY = 'self-driving-playground:host-session:v1';

export interface HostRoom {
  roomCode?: string;
  status: ConnectionStatus;
  players: PlayerSummary[];
  presentation: PresentationState;
  /** True once the room's saved presentation state has arrived; before that, `presentation` is only the default. */
  ready: boolean;
  updatePresentation: (next: PresentationState) => void;
  /** Closes the current room and opens a new one with a new code. */
  newRoom: () => Promise<void>;
  error?: string;
}

/**
 * Host connection without a race engine: tracks players and controls what they see.
 * Races still run on /host, which can be open at the same time in the same room.
 */
export function useHostRoom(): HostRoom {
  const [session, setSession] = useState<CreateRoomResponse | undefined>(() => readStoredJson(HOST_SESSION_KEY));
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [players, setPlayers] = useState<Map<string, PlayerSummary>>(new Map());
  const [presentation, setPresentation] = useState<PresentationState>(DEFAULT_PRESENTATION);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const connectionRef = useRef<RoomConnection<ServerToHostMessage, HostToServerMessage>>();

  const newRoom = useCallback(async () => {
    setError(undefined);
    try {
      const created = await createRoom();
      writeStoredJson(HOST_SESSION_KEY, created);
      setPlayers(new Map());
      setReady(false);
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
    void newRoom();
  }, [session, newRoom]);

  useEffect(() => {
    if (!session) return undefined;
    const connection = new RoomConnection<ServerToHostMessage, HostToServerMessage>(
      roomSocketUrl(session.roomCode, { role: 'host', token: session.hostToken }),
      (message) => {
        switch (message.type) {
          case 'room':
            setPlayers(new Map(message.players.map((player) => [player.id, player])));
            setPresentation({ ...DEFAULT_PRESENTATION, ...message.presentation });
            setReady(true);
            break;
          case 'player':
            setPlayers((current) => new Map(current).set(message.player.id, message.player));
            break;
          case 'presentation':
            setPresentation(message.state);
            break;
          case 'error':
            setError(message.message);
            break;
        }
      },
      setStatus,
    );
    connectionRef.current = connection;
    return () => {
      connection.close();
      connectionRef.current = undefined;
    };
  }, [session]);

  const updatePresentation = useCallback((next: PresentationState) => {
    setPresentation(next);
    connectionRef.current?.send({ type: 'presentation', state: next });
  }, []);

  return {
    roomCode: session?.roomCode,
    status,
    players: [...players.values()],
    presentation,
    ready,
    updatePresentation,
    newRoom,
    error,
  };
}
