import type { PlayerRaceState } from '../simulation';
import type { LeaderboardEntry, RoundResult } from './protocol';

/** Scoring rules shown on the presenter screen. Points are meters of progress minus penalties. */
export const RACE_SCORING = {
  /** Points lost for each collision the player caused. */
  atFaultPenalty: 150,
  /** Points lost for each collision the player was involved in but did not cause. */
  involvedPenalty: 25,
  /** Points lost each time the player's car hits the road edge. */
  edgeHitPenalty: 40,
  /** Seconds the at-fault car coasts with no throttle after causing a collision. */
  atFaultStallSeconds: 1.5,
} as const;

export function roundPoints(
  state: Pick<PlayerRaceState, 'distance' | 'collisions' | 'atFaultCollisions' | 'edgeHits'>,
): number {
  const notAtFault = Math.max(0, state.collisions - state.atFaultCollisions);
  return Math.round(
    state.distance -
      state.atFaultCollisions * RACE_SCORING.atFaultPenalty -
      notAtFault * RACE_SCORING.involvedPenalty -
      state.edgeHits * RACE_SCORING.edgeHitPenalty,
  );
}

export function scoreRound(round: number, states: PlayerRaceState[]): Map<string, RoundResult> {
  const ranked = states
    .map((state) => ({ state, points: roundPoints(state) }))
    .sort((a, b) => b.points - a.points || b.state.distance - a.state.distance);

  return new Map(
    ranked.map(({ state, points }, index) => [
      state.id,
      {
        round,
        distance: Math.round(state.distance),
        collisions: state.collisions,
        atFaultCollisions: state.atFaultCollisions,
        edgeHits: state.edgeHits,
        points,
        place: index + 1,
        finishedRacers: ranked.length,
      },
    ]),
  );
}

/** Adds a round's results to the cumulative leaderboard and returns it sorted best first. */
export function applyRoundResults(
  entries: LeaderboardEntry[],
  results: Map<string, RoundResult>,
  names: ReadonlyMap<string, string>,
): LeaderboardEntry[] {
  const byId = new Map(entries.map((entry) => [entry.playerId, { ...entry }]));
  for (const [playerId, result] of results) {
    const previous = byId.get(playerId);
    byId.set(playerId, {
      playerId,
      name: names.get(playerId) ?? previous?.name ?? 'Driver',
      totalPoints: (previous?.totalPoints ?? 0) + result.points,
      bestRoundPoints: previous && previous.roundsRaced > 0 ? Math.max(previous.bestRoundPoints, result.points) : result.points,
      roundsRaced: (previous?.roundsRaced ?? 0) + 1,
      totalAtFault: (previous?.totalAtFault ?? 0) + result.atFaultCollisions,
      lastRound: result,
    });
  }
  for (const [playerId, entry] of byId) {
    const name = names.get(playerId);
    if (name) entry.name = name;
  }
  return sortLeaderboard([...byId.values()]);
}

export function sortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort(
    (a, b) => b.totalPoints - a.totalPoints || b.bestRoundPoints - a.bestRoundPoints || a.name.localeCompare(b.name),
  );
}
