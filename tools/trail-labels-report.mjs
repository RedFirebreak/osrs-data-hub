#!/usr/bin/env node
/**
 * What the labels of a location trail are made of (D-103): points per `via`, the time between
 * points, `move` steps that are further than one tick's run, where the `teleport` steps cluster and
 * how fast boats go. Reads only.
 *
 *   HUB_URL=https://hub.example.com HUB_API_KEY=ohub_… node tools/trail-labels-report.mjs --list
 *   HUB_URL=… HUB_API_KEY=… node tools/trail-labels-report.mjs --account <id> [--hours 24]
 *   node tools/trail-labels-report.mjs --file saved-response.json [--file older-page.json]
 *
 * The key needs `location_history` of the account. `--file` takes saved answers of
 * GET /api/v1/accounts/{id}/locations.
 */

const TICK_MS = 600;
/** One tick on foot as classifyStep allows it: 2 tiles and 6 of margin. */
const ONE_TICK_REACH = 8;
const HOUSE = { minX: 1852, maxX: 2115, minY: 7036, maxY: 7116 };

const args = process.argv.slice(2);
const flag = (name) => {
  const values = [];
  args.forEach((a, i) => a === `--${name}` && values.push(args[i + 1]));
  return values;
};
const base = (process.env.HUB_URL ?? '').replace(/\/+$/, '');

async function get(path) {
  const key = process.env.HUB_API_KEY;
  if (!base || !key) throw new Error('Set HUB_URL and HUB_API_KEY, or pass --file.');
  const res = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}: ${await res.text()}`);
  return (await res.json()).data;
}

/** The whole range, paging backwards while the hub says older points were left out. */
async function fetchTrail(account, hours) {
  const from = new Date(Date.now() - hours * 3600_000).toISOString();
  let to = new Date().toISOString();
  let points = [];
  for (;;) {
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const page = await get(`/accounts/${encodeURIComponent(account)}/locations?${query}`);
    // The first point of the newer page is returned again as the last of the older one.
    points = [...page.points, ...points.slice(points.length > 0 ? 1 : 0)];
    if (!page.truncated || page.points.length === 0) return points;
    to = page.points[0].at;
  }
}

async function readFiles(files) {
  const { readFile } = await import('node:fs/promises');
  const seen = new Map();
  for (const file of files) {
    const body = JSON.parse(await readFile(file, 'utf8'));
    for (const p of (body.data ?? body).points) seen.set(p.at, p);
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const region = (p) => ((p.x >> 6) << 8) | (p.y >> 6);
const regionBox = (id) =>
  `x ${(id >> 8) * 64}-${(id >> 8) * 64 + 63}, y ${(id & 255) * 64}-${(id & 255) * 64 + 63}`;
const inHouse = (p) =>
  p.x >= HOUSE.minX && p.x <= HOUSE.maxX && p.y >= HOUSE.minY && p.y <= HOUSE.maxY;
const tile = (p) => `${p.x},${p.y},${p.plane}${p.is_on_boat ? ' boat' : ''}`;

function count(into, key, by = 1) {
  into.set(key, (into.get(key) ?? 0) + by);
}
function table(title, rows, limit = Infinity) {
  console.log(`\n${title}`);
  if (rows.length === 0) console.log('  (none)');
  for (const row of rows.slice(0, limit)) console.log(`  ${row}`);
  if (rows.length > limit) console.log(`  … ${rows.length - limit} more`);
}
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const pad = (value, width) => String(value).padStart(width);

function report(points) {
  if (points.length === 0) return console.log('No points.');
  console.log(`${points.length} points, ${points[0].at} to ${points.at(-1).at}`);

  const steps = points.slice(1).map((next, i) => {
    const prev = points[i];
    return {
      prev,
      next,
      via: next.via,
      elapsed: Date.parse(next.at) - Date.parse(prev.at),
      far: Math.max(Math.abs(next.x - prev.x), Math.abs(next.y - prev.y)),
      boat: Boolean(prev.is_on_boat) && Boolean(next.is_on_boat),
    };
  });

  const perVia = new Map();
  for (const p of points) count(perVia, String(p.via));
  table(
    'Points per via',
    sorted(perVia).map(([via, n]) => `${pad(n, 7)}  ${via}`),
  );

  const onTheMinute = points.filter((p) => Date.parse(p.at) % 60_000 === 0).length;
  console.log(`\nPoints dated on a whole minute (a minute sample of plugin 1.5): ${onTheMinute}`);

  const spans = [
    ['one tick (up to 0.9 s)', 900],
    ['2 to 5 ticks (up to 3.3 s)', 3300],
    ['up to 55 s', 55_000],
    ['55 to 65 s (a point a minute)', 65_000],
    ['up to 5 min', 300_000],
    ['more than 5 min', Infinity],
  ];
  const perSpan = new Map(spans.map(([name]) => [name, 0]));
  for (const s of steps) count(perSpan, spans.find(([, max]) => s.elapsed <= max)[0]);
  table(
    'Time between two points',
    [...perSpan].map(([name, n]) => `${pad(n, 7)}  ${name}`),
  );

  // Problem 1: a move that one tick on foot (or by boat) doesn't cover.
  const longMoves = steps.filter(
    (s) => s.via === 'move' && s.far > (s.boat ? ONE_TICK_REACH + 2 : ONE_TICK_REACH),
  );
  const perWait = new Map();
  for (const s of longMoves) {
    count(perWait, spans.find(([, max]) => s.elapsed <= max)[0]);
  }
  table(
    `Moves further than one tick's reach (${ONE_TICK_REACH} tiles, 10 on a boat): ${longMoves.length}`,
    [...perWait].map(([name, n]) => `${pad(n, 7)}  after ${name}`),
  );
  table(
    'The furthest of them',
    [...longMoves]
      .sort((a, b) => b.far - a.far)
      .map(
        (s) =>
          `${pad(s.far, 5)} tiles after ${pad((s.elapsed / 1000).toFixed(1), 6)} s  ${s.next.at}  ${tile(s.prev)} -> ${tile(s.next)}`,
      ),
    25,
  );

  // Problem 2: where the teleports are.
  const teleports = steps.filter((s) => s.via === 'teleport');
  const kinds = new Map();
  const pairs = new Map();
  const ends = new Map();
  for (const s of teleports) {
    const [a, b] = [region(s.prev), region(s.next)];
    count(pairs, `${a} -> ${b}`);
    count(ends, a);
    if (b !== a) count(ends, b);
    if (s.prev.is_on_boat || s.next.is_on_boat) count(kinds, 'a boat at either end');
    if (inHouse(s.prev) !== inHouse(s.next)) count(kinds, 'into or out of the house');
    if (a === b) count(kinds, 'inside one region (64 x 64)');
    count(kinds, s.elapsed <= 900 ? 'one tick after the point before' : 'later than one tick');
    if (s.far <= 64) count(kinds, 'at most 64 tiles');
  }
  table(
    `Teleports: ${teleports.length}`,
    sorted(kinds).map(([name, n]) => `${pad(n, 7)}  ${name}`),
  );
  table(
    'Regions the teleports start or end in (region id, tiles)',
    sorted(ends).map(([id, n]) => `${pad(n, 7)}  ${pad(id, 5)}  ${regionBox(id)}`),
    25,
  );
  table(
    'From region -> to region',
    sorted(pairs).map(([pair, n]) => `${pad(n, 7)}  ${pair}`),
    25,
  );

  // Teleports that follow each other closely: rooms of an instance, rather than a spell.
  const runs = [];
  let run = [];
  for (const s of steps) {
    if (
      s.via === 'teleport' &&
      (run.length === 0 || Date.parse(s.next.at) - run.at(-1) <= 120_000)
    ) {
      run.push(Date.parse(s.next.at));
    } else if (s.via === 'teleport') {
      runs.push(run);
      run = [Date.parse(s.next.at)];
    }
  }
  if (run.length > 0) runs.push(run);
  const inRuns = runs.filter((r) => r.length >= 5);
  console.log(
    `\nTeleports in a run of 5 or more with at most 2 min between them: ${inRuns.reduce((n, r) => n + r.length, 0)} in ${inRuns.length} runs`,
  );

  // Boats: tiles covered in one tick while both points are on one.
  const perSpeed = new Map();
  for (const s of steps) {
    if (s.boat && s.elapsed <= 900) count(perSpeed, Math.min(s.far, 12));
  }
  table(
    'Boat: tiles in one tick (both points on a boat; 12 stands for 12 or more)',
    [...perSpeed].sort((a, b) => a[0] - b[0]).map(([far, n]) => `${pad(n, 7)}  ${far}`),
  );
  const boatBreaks = new Map();
  for (const s of steps) if (s.boat && s.via !== 'move') count(boatBreaks, String(s.via));
  table(
    'Boat: steps that are not a move',
    sorted(boatBreaks).map(([via, n]) => `${pad(n, 7)}  ${via}`),
  );
}

const files = flag('file');
if (args.includes('--list')) {
  for (const a of await get('/accounts')) console.log(`${a.id}  ${a.name}`);
} else if (files.length > 0) {
  report(await readFiles(files));
} else {
  const [account] = flag('account');
  if (!account) throw new Error('Pass --account <id>, --list or --file <path>.');
  report(await fetchTrail(account, Number(flag('hours')[0] ?? 24)));
}
