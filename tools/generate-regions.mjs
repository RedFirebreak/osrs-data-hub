#!/usr/bin/env node
// Builds packages/core/src/regions/regions.json (region id -> place name, D-138) from RuneLite's
// DiscordGameEventType.java, which names the map regions of cities, dungeons, bosses, minigames and
// raids. RuneLite is BSD-2-Clause licensed; the notice is kept in packages/core/src/regions/NOTICE.
//
//   node tools/generate-regions.mjs path/to/DiscordGameEventType.java
//
// The file is in RuneLite's client sources (net/runelite/client/plugins/discord/). When two entries
// name the same region, the first one wins; the file lists bosses before cities, dungeons,
// minigames, raids and wider regions. Ported from ha-osrs-map's site/scripts/generate-regions.js.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('usage: node tools/generate-regions.mjs path/to/DiscordGameEventType.java');
  process.exit(1);
}

const java = readFileSync(source, 'utf8');
const entry = /^\s*[A-Z0-9_]+\(\s*"([^"]+)"\s*,\s*DiscordAreaType\.([A-Z_]+)\s*,\s*([\d,\s]+)\)/gm;

const regions = {};
const counts = {};
for (const match of java.matchAll(entry)) {
  const [, name, type, ids] = match;
  counts[type] = (counts[type] ?? 0) + 1;
  for (const id of ids.split(',').map((value) => Number.parseInt(value.trim(), 10))) {
    if (!Number.isNaN(id) && !(id in regions)) regions[id] = name;
  }
}

const output = {
  source: 'RuneLite DiscordGameEventType (BSD-2-Clause), see NOTICE',
  regions,
};
const target = path.join(import.meta.dirname, '../packages/core/src/regions/regions.json');
writeFileSync(target, JSON.stringify(output) + '\n');
console.log(`Wrote ${Object.keys(regions).length} regions to ${target}`, counts);
