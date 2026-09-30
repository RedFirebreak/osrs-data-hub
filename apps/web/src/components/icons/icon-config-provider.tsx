'use client';
/**
 * The icon configuration (base URL and stack tables, D-95) for client components. The (app) layout
 * loads it on the server at request time (lib/osrs-icons-server.ts) and mounts this provider around
 * the signed-in page tree. Outside it, useIconConfig() answers "icons off" (NO_ICONS), so shared
 * components fall back to their text on public pages and in unit tests.
 */
import { createContext, useContext } from 'react';
import { NO_ICONS, type IconConfig } from '@/lib/osrs-icons';

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
