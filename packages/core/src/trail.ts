/**
 * How a player got from one point of the location trail to the next (D-103). Judged when a trail is
 * read, never stored: a late payload can still add a point between two that are already there.
 */

import { LOCATION_BUCKET_MS } from './time';

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
/**
 * Other instances the game builds from copied rooms, in another order than they lie on the map: the
 * same jump between neighbouring rooms. By map region (64 by 64 tiles, `regionId`), the ids RuneLite
 * knows them by (DiscordGameEventType).
 */
export const INSTANCE_REGIONS = {
  gauntlet: [7512],
  corruptedGauntlet: [7768],
  chambersOfXeric: [
    12889, 13136, 13137, 13138, 13139, 13140, 13141, 13145, 13393, 13394, 13395, 13396, 13397,
    13401,
  ],
} as const;

export const TRAIL_STEPS = ['move', 'entrance', 'house', 'instance', 'teleport', 'gap'] as const;
/**
 * - `move`: within reach on foot, or by boat when both points are on one. Stairs are a move to
 *   another plane.
 * - `entrance`: into or out of the underground.
 * - `house`: from one room of a player-owned house to another. Walked, but the coordinates jump.
 * - `instance`: the same between two rooms of one of INSTANCE_REGIONS.
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

/** The map region a tile is in, as the game numbers them. */
export function regionId(p: { x: number; y: number }): number {
  return ((p.x >> 6) << 8) | (p.y >> 6);
}

const INSTANCE_OF_REGION = new Map<number, string>(
  Object.entries(INSTANCE_REGIONS).flatMap(([name, regions]) => regions.map((id) => [id, name])),
);

function inOneInstance(a: TrailTile, b: TrailTile): boolean {
  const instance = INSTANCE_OF_REGION.get(regionId(a));
  return instance !== undefined && instance === INSTANCE_OF_REGION.get(regionId(b));
}

/**
 * The step from `prev` to `next`, two consecutive points of one account's trail. `world` plays no
 * part: tiles walked just before a hop carry the new world (D-102).
 *
 * A point of plugin 1.6 is the tick on which the tile changed, so the step to it took one tick,
 * however long the player stood on the point before. A minute sample of an older plugin is told
 * from it by its time, the whole minute (D-102): there the reach is what can be run since the point
 * before, 200 tiles for a minute, so a shorter teleport reads as a move.
 */
export function classifyStep(prev: TrailTile, next: TrailTile): TrailStep {
  const elapsed = next.ts.getTime() - prev.ts.getTime();
  if (elapsed > TRAIL_GAP_MS) return 'gap';
  const minuteSample = next.ts.getTime() % LOCATION_BUCKET_MS === 0;
  const ticks = minuteSample ? Math.max(1, Math.ceil(elapsed / GAME_TICK_MS)) : 1;
  const speed = prev.onBoat && next.onBoat ? BOAT_TILES_PER_TICK : RUN_TILES_PER_TICK;
  const reach = ticks * speed + TRAIL_SLACK_TILES;
  // Diagonal steps cost the same as straight ones.
  const far = (shiftY: number) =>
    Math.max(Math.abs(next.x - prev.x), Math.abs(next.y - prev.y - shiftY));
  if (far(0) <= reach) return 'move';
  if (inHouse(prev) && inHouse(next)) return 'house';
  if (inOneInstance(prev, next)) return 'instance';
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
