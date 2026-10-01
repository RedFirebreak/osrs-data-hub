/**
 * The route files under app/api/v1, found by walking the directory (imported by *.test.ts only):
 * tests that hold for "every v1 route" (the OpenAPI document, the preflight, the metrics' route
 * groups) read this list, so a route added later can't be left out of them.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

export interface V1RouteFile {
  /** Directory names from app/api/v1 down: ['accounts', '[id]', 'xp']. */
  segments: string[];
  /** Absolute path of the route.ts. */
  file: string;
  /** The `[[...rest]]` route that answers every unknown path. */
  catchAll: boolean;
}

export function v1RouteFiles(): V1RouteFile[] {
  const out: V1RouteFile[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.name === 'route.ts') {
        const catchAll = segments.some((s) => s.startsWith('[[...') || s.startsWith('[...'));
        out.push({ segments, file: path.join(dir, entry.name), catchAll });
      }
    }
  };
  walk(import.meta.dirname, []);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
