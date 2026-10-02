/**
 * How a player got from one point of the location trail to the next (D-103). Judged when a trail is
 * read, never stored: a late payload can still add a point between two that are already there.
 */

/** One game tick: the plugin looks where the player is this often. */
export const GAME_TICK_MS = 600;
/** Running covers two tiles a game tick. */
export const RUN_TILES_PER_TICK = 2;
/** A guess: nothing says how fast a boat goes. Twice a run, as the live map assumes. */
export const BOAT_TILES_PER_TICK = 4;
/** Margin on what can be walked: after lag the position catches up several tiles at once. */
export const TRAIL_SLACK_TILES = 6;
/**
 * Two points further apart in time than this say nothing about what happened in between: a player
 * standing still keeps one point a minute (D-102), so the account was offline, not sharing, or the
 * points never arrived.
 */
export const TRAIL_GAP_MS = 5 * 60 * 1000;
/** The underground (caves, dungeons, basements) is the surface, this many tiles further north. */
export const UNDERGROUND_OFFSET_Y = 6400;
/**
 * Where the rooms of a player-owned house are, on every plane. The plugin reports the tile of the
 * map area each room was copied from, so walking into the next room looks like a jump across this
 * box.
 */
export const HOUSE_AREA = { minX: 1852, maxX: 2115, minY: 7036, maxY: 7116 } as const;

export const TRAIL_STEPS = ['move', 'entrance', 'house', 'teleport', 'gap'] as const;
/**
 * - `move`: within reach on foot, or by boat when both points are on one, in the time between the
 *   points. Stairs are a move to another plane.
 * - `entrance`: into or out of the underground.
 * - `house`: from one room of a player-owned house to another. Walked, but the coordinates jump.
 * - `teleport`: anything else that wasn't walked.
 * - `gap`: more than TRAIL_GAP_MS between the points.
 */
export type TrailStep = (typeof TRAIL_STEPS)[number];

export interface TrailTile {
  ts: Date;
  x: number;
  y: number;
  onBoat: boolean;
}

function inHouse(p: TrailTile): boolean {
  return (
    p.x >= HOUSE_AREA.minX &&
    p.x <= HOUSE_AREA.maxX &&
    p.y >= HOUSE_AREA.minY &&
    p.y <= HOUSE_AREA.maxY
  );
}

/**
 * The step from `prev` to `next`, two consecutive points of one account's trail. `world` plays no
 * part: tiles walked just before a hop carry the new world (D-102). With one point a minute (an
 * older plugin) the reach is 200 tiles, so a shorter teleport reads as a move.
 */
export function classifyStep(prev: TrailTile, next: TrailTile): TrailStep {
  const elapsed = next.ts.getTime() - prev.ts.getTime();
  if (elapsed > TRAIL_GAP_MS) return 'gap';
  const ticks = Math.max(1, Math.ceil(elapsed / GAME_TICK_MS));
  const speed = prev.onBoat && next.onBoat ? BOAT_TILES_PER_TICK : RUN_TILES_PER_TICK;
  const reach = ticks * speed + TRAIL_SLACK_TILES;
  // Diagonal steps cost the same as straight ones.
  const far = (shiftY: number) =>
    Math.max(Math.abs(next.x - prev.x), Math.abs(next.y - prev.y - shiftY));
  if (far(0) <= reach) return 'move';
  if (inHouse(prev) && inHouse(next)) return 'house';
  if (far(UNDERGROUND_OFFSET_Y) <= reach || far(-UNDERGROUND_OFFSET_Y) <= reach) return 'entrance';
  return 'teleport';
}

/**
 * The step that led to each point of a trail, oldest first. The first point's is judged from
 * `before`, the point just before the trail, and is null without one.
 */
export function trailSteps(
  points: readonly TrailTile[],
  before: TrailTile | null = null,
): (TrailStep | null)[] {
  return points.map((point, i) => {
    const prev = i === 0 ? before : points[i - 1]!;
    return prev === null ? null : classifyStep(prev, point);
  });
}
