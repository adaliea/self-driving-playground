export interface RaceCameraOptions {
  /** Width of the area cars are drawn in, in CSS pixels. */
  viewportWidth: number;
  /** Pixels per meter limits. */
  minScale: number;
  maxScale: number;
  /** Cars further than this behind the leader are left out of the framing. */
  packWindowMeters: number;
}

export interface RaceCameraTarget {
  centerS: number;
  scale: number;
}

/** Road meters added around the pack so cars are not drawn against the edges. */
const PADDING_METERS = 70;
/** The leader is kept at least this far from the right edge, in pixels. */
const LEADER_MARGIN_PX = 110;

/**
 * Where to point the camera so the pack fits and the leader is always on screen.
 * Zooms out to fit cars within the pack window; if even the closest zoom limit
 * can't fit them, the stragglers go off the left edge, never the leader.
 */
export function raceCameraTarget(positions: readonly number[], options: RaceCameraOptions): RaceCameraTarget | undefined {
  if (positions.length === 0) return undefined;
  const leaderS = Math.max(...positions);
  const packMinS = Math.min(...positions.filter((s) => s > leaderS - options.packWindowMeters));
  const span = leaderS - packMinS + PADDING_METERS;
  const scale = Math.max(options.minScale, Math.min(options.maxScale, (options.viewportWidth * 0.85) / span));
  let centerS = (packMinS + leaderS) / 2 + 12;
  const furthestAheadOfCenter = (options.viewportWidth / 2 - LEADER_MARGIN_PX) / scale;
  if (leaderS - centerS > furthestAheadOfCenter) centerS = leaderS - furthestAheadOfCenter;
  return { centerS, scale };
}
