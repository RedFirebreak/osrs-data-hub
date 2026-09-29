import './globals.css';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { ThemeProvider } from '@/components/shell/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'osrs-data-hub',
  description: 'OSRS account data for the guild, from the HA Exporter RuneLite plugin.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // geist package instead of next/font/google: offline-safe builds (see TOOL-2).
    <html lang="en" className={cn('font-sans', GeistSans.variable)} suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
          {/* Below the sticky 56px app header (h-14), not over the user menu. */}
          <Toaster
            position="top-right"
            offset={{ top: 72 }}
            mobileOffset={{ top: 64 }}
            richColors
            closeButton
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
