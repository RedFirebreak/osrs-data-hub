/**
 * Place names for game tiles (D-138): the game's 64 by 64 map regions named after RuneLite's
 * DiscordGameEventType (regions.json, BSD-2-Clause, see NOTICE here; built by
 * tools/generate-regions.mjs), plus the places that follow from the coordinates themselves: the
 * Wilderness and its level, the Ferox Enclave, instances. Ported from ha-osrs-map's
 * site/src/data/regions.js, which reads them back from GET /api/v1/regions.json, so there is one
 * copy.
 *
 * A region without a name borrows one from a neighbour ("Near Lumbridge"); a tile no rule names is
 * null.
 */
import { regionId } from '../trail';
import data from './regions.json';

/** Region id → place name, as regions.json lists them. */
export const REGION_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(data.regions).map(([id, name]) => [Number(id), name]),
);

/** Where the names come from, for whoever passes them on (/api/v1/regions.json). */
export const REGION_NAMES_SOURCE = data.source;

/** The world ends at this x. East of it the game keeps the areas it makes for one group at a time. */
const INSTANCE_SPACE_FROM_X = 6400;

/** Whether a tile's x is in instance space: where an instance really is, not the place it copies. */
export function inInstanceSpace(x: number): boolean {
  return x >= INSTANCE_SPACE_FROM_X;
}

/**
 * The regions of the dungeons under the Wilderness that are Wilderness too: the Edgeville Dungeon
 * past its gate, the God Wars Dungeon, the Revenant Caves, the Slayer Cave, the Lava Maze and Deep
 * Wilderness dungeons, the agility course's pit and Scorpia's cave. The other dungeons in that
 * rectangle (the Slayer Tower's basement, the Ferox Enclave Dungeon) are not.
 */
const WILDERNESS_DUNGEONS: ReadonlySet<number> = new Set([
  12443, 12444, 12190, 12701, 12702, 12703, 12957, 12958, 12959, 13469, 13470, 13725, 13726, 12192,
  12193, 11937, 12961,
]);

/** The boss lairs and the caves between them: their level doesn't follow from where they are. */
const WILDERNESS_LAIRS: ReadonlyMap<number, string> = new Map([
  [13473, '40'], // Callisto's Den
  [13215, '35'], // Vet'ion's Rest
  [13727, '35'], // Silk Chasm
  [13472, '30-42'], // Escape Caves
  [7092, '21'], // Hunter's End
  [7604, '21'], // Skeletal Tomb
  [6580, '29'], // Web Chasm
]);

/** The enclave is a safe zone inside the Wilderness (its outline, roughly). */
function inFeroxEnclave(x: number, y: number): boolean {
  return x >= 3123 && x <= 3155 && y >= 3617 && y <= 3646;
}

function wildernessLevel(x: number, y: number): string | number | null {
  const id = regionId({ x, y });
  const lair = WILDERNESS_LAIRS.get(id);
  if (lair !== undefined) return lair;
  const dungeon = WILDERNESS_DUNGEONS.has(id);
  if (!dungeon && (x < 2944 || x >= 3392)) return null;
  // A Wilderness dungeon has the level of the surface 6400 tiles south of it.
  const surfaceY = dungeon ? y - 6400 : y;
  // The ditch runs along y 3522; the levels count from two tiles south of it.
  if (surfaceY <= 3522 || surfaceY >= 3968) return null;
  return Math.floor((surfaceY - 3520) / 8) + 1;
}

const NEIGHBOURS = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/**
 * The name of the place at game tile (x, y), as the plugin reports tiles: "Lumbridge", "Near
 * Lumbridge", "Wilderness (level 12)", "Ferox Enclave", "An instance", or null. `names` is for tests.
 */
export function regionName(
  x: number,
  y: number,
  names: ReadonlyMap<number, string> = REGION_NAMES,
): string | null {
  if (inFeroxEnclave(x, y)) return 'Ferox Enclave';
  const level = wildernessLevel(x, y);
  if (level !== null) return `Wilderness (level ${level})`;
  const exact = names.get(regionId({ x, y }));
  if (exact !== undefined) return exact;
  // Instanced areas (raids, most bosses) are copied far east of the world.
  if (inInstanceSpace(x)) return 'An instance';
  for (const [dx, dy] of NEIGHBOURS) {
    const near = names.get(regionId({ x: x + dx * 64, y: y + dy * 64 }));
    if (near !== undefined) return `Near ${near}`;
  }
  return null;
}
