'use client';
/**
 * Light and dark mode: next-themes puts `class="dark"` on <html> (the `dark:` variant and the `.dark`
 * variables in globals.css key on it), following the OS setting unless the user picks one in the
 * account menu (kept in localStorage). Its inline script sets the class before the first paint, so
 * a dark page doesn't flash white. Sonner's Toaster reads the same theme (components/ui/sonner.tsx).
 */
import { ThemeProvider as NextThemesProvider } from 'next-themes';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
