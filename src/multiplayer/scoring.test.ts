import { describe, expect, it } from 'vitest';
import type { PlayerRaceState } from '../simulation';
import { parseHostMessage, sanitizePlayerName } from './protocol';
import { RACE_SCORING, applyRoundResults, roundPoints, scoreRound } from './scoring';

function state(id: string, distance: number, collisions = 0, atFaultCollisions = 0): PlayerRaceState {
  return { id, distance, s: distance, speed: 20, laneIndex: 1, collisions, atFaultCollisions, stalled: false };
}

describe('race scoring', () => {
  it('rewards distance and penalizes at-fault collisions far more than involvement', () => {
    expect(roundPoints(state('a', 1000))).toBe(1000);
    expect(roundPoints(state('a', 1000, 1, 1))).toBe(1000 - RACE_SCORING.atFaultPenalty);
    expect(roundPoints(state('a', 1000, 1, 0))).toBe(1000 - RACE_SCORING.involvedPenalty);
    expect(RACE_SCORING.atFaultPenalty).toBeGreaterThan(RACE_SCORING.involvedPenalty * 4);
  });

  it('ranks a careful driver above a faster driver who caused crashes', () => {
    const results = scoreRound(3, [state('fast', 1100, 2, 2), state('careful', 1000)]);
    expect(results.get('careful')).toMatchObject({ place: 1, points: 1000, round: 3, finishedRacers: 2 });
    expect(results.get('fast')).toMatchObject({ place: 2, atFaultCollisions: 2 });
  });

  it('accumulates totals and best rounds across rounds', () => {
    const names = new Map([['a', 'Ada'], ['b', 'Bea']]);
    let board = applyRoundResults([], scoreRound(1, [state('a', 500), state('b', 600)]), names);
    expect(board.map((entry) => entry.playerId)).toEqual(['b', 'a']);
    board = applyRoundResults(board, scoreRound(2, [state('a', 800, 1, 1)]), names);
    const ada = board.find((entry) => entry.playerId === 'a')!;
    expect(ada).toMatchObject({ totalPoints: 500 + 650, bestRoundPoints: 650, roundsRaced: 2, totalAtFault: 1 });
    expect(board.find((entry) => entry.playerId === 'b')).toMatchObject({ totalPoints: 600, roundsRaced: 1 });
    expect(board[0].playerId).toBe('a');
  });
});

describe('room protocol validation', () => {
  it('strips control and bidi characters from names', () => {
    expect(sanitizePlayerName('  Ada‮\u0000  Lovelace ')).toBe('Ada Lovelace');
    expect(sanitizePlayerName('​')).toBeUndefined();
    expect(sanitizePlayerName('x'.repeat(100))).toHaveLength(24);
  });

  it('rejects malformed host messages', () => {
    expect(parseHostMessage({ type: 'leaderboard', entries: [{ playerId: 'a', name: 'A' }] })).toBeUndefined();
    expect(parseHostMessage({ type: 'driver-status', playerId: 'a', version: 1, status: 'hacked' })).toBeUndefined();
    expect(parseHostMessage({ type: 'round-state', state: { phase: 'racing', round: 2, endsAt: 5 } })).toEqual({
      type: 'round-state',
      state: { phase: 'racing', round: 2, endsAt: 5, racingVersions: undefined },
    });
  });
});
