// The server under test, started by Playwright's webServer (playwright.config.ts):
//
// 1. `next build` (skipped with E2E_SKIP_BUILD=1, e.g. in CI where a separate step built it);
// 2. copies .next/static and public next to the standalone server.js, as the Dockerfile does: the
//    standalone output doesn't include them, and without the client JS no button on a page works;
// 3. runs the standalone server (HOSTNAME/PORT from the environment) with the fake Discord preloaded
//    through NODE_OPTIONS="--import …/mock-discord.mjs". Only the server gets the mock, the database
//    and the secrets; the build runs without them, like the image build.
//
// Exits with the server's exit code, and passes SIGINT/SIGTERM on to it.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = path.join(import.meta.dirname, '..');
const standaloneApp = path.join(appDir, '.next', 'standalone', 'apps', 'web');
const serverJs = path.join(standaloneApp, 'server.js');
const mock = path.join(import.meta.dirname, 'mock-discord.mjs');

/** Secrets and the database only the running server gets (from playwright.config.ts's webServer.env). */
const RUNTIME_ONLY = ['DATABASE_URL', 'AUTH_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];

if (process.env.E2E_SKIP_BUILD !== '1') {
  const buildEnv = { ...process.env };
  for (const name of RUNTIME_ONLY) delete buildEnv[name];
  // On Windows pnpm is pnpm.cmd, which spawn only finds through a shell (TOOL-10).
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: appDir,
    env: buildEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error(
      `e2e: next build failed (${build.error?.message ?? build.status ?? build.signal})`,
    );
    process.exit(1);
  }
}

if (!existsSync(serverJs)) {
  console.error(`e2e: ${serverJs} is missing: run \`pnpm --filter @hub/web build\` first`);
  process.exit(1);
}

for (const [from, to] of [
  [path.join(appDir, '.next', 'static'), path.join(standaloneApp, '.next', 'static')],
  [path.join(appDir, 'public'), path.join(standaloneApp, 'public')],
]) {
  rmSync(to, { recursive: true, force: true });
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

// --import takes a URL: a bare Windows path (E:\…) reads as scheme "e:" (TOOL-10).
const nodeOptions = [
  process.env.NODE_OPTIONS,
  `--import ${JSON.stringify(pathToFileURL(mock).href)}`,
]
  .filter(Boolean)
  .join(' ');
const server = spawn(process.execPath, [serverJs], {
  cwd: standaloneApp,
  env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: nodeOptions },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
