'use client';
/**
 * The icon configuration (base URL and stack tables, D-95) for client components. The (app) layout
 * reads OSRS_ICONS_URL on the server at request time and mounts IconConfigLoader around the signed-in
 * page tree with just the base URL; the browser fetches the stack tables (`/data/stacks.json`) once
 * per page load, from its HTTP cache after the first, so they never hold up a render or ride along in
 * every RSC payload. Outside a provider, useIconConfig() answers "icons off" (NO_ICONS), so shared
 * components fall back to their text on public pages and in unit tests.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { NO_ICONS, parseStacks, type IconConfig, type IconStacks } from '@/lib/osrs-icons';

const IconConfigContext = createContext<IconConfig>(NO_ICONS);

export function IconConfigProvider({
  value,
  children,
}: {
  value: IconConfig;
  children: React.ReactNode;
}) {
  return <IconConfigContext value={value}>{children}</IconConfigContext>;
}

export function useIconConfig(): IconConfig {
  return useContext(IconConfigContext);
}

/** One fetch of the stack tables per base and page load; {} (base pictures only) on any failure. */
const stacksByBase = new Map<string, Promise<IconStacks>>();

function loadIconStacks(base: string): Promise<IconStacks> {
  let promise = stacksByBase.get(base);
  if (!promise) {
    promise = fetch(`${base}/data/stacks.json`)
      .then((res) => (res.ok ? res.json() : {}))
      .then(parseStacks)
      .catch(() => ({}));
    stacksByBase.set(base, promise);
  }
  return promise;
}

/** The provider for a base URL (null = icons off), with the stack tables once they have loaded. */
export function IconConfigLoader({
  base,
  children,
}: {
  base: string | null;
  children: React.ReactNode;
}) {
  const [loaded, setLoaded] = useState<{ base: string; stacks: IconStacks } | null>(null);
  useEffect(() => {
    if (!base) return;
    let live = true;
    void loadIconStacks(base).then((stacks) => {
      if (live) setLoaded({ base, stacks });
    });
    return () => {
      live = false;
    };
  }, [base]);
  const stacks = !base ? NO_ICONS.stacks : loaded?.base === base ? loaded.stacks : null;
  const value = useMemo<IconConfig>(() => ({ base, stacks }), [base, stacks]);
  return <IconConfigProvider value={value}>{children}</IconConfigProvider>;
}
