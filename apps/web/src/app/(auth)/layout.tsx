/**
 * Public sign-in pages: one centred column, no app chrome. The footer is where a visitor (or
 * anyone judging whether this is a phishing page) can check what the site is before signing in:
 * what it stores, the project it belongs to and its source, and that it isn't Jagex.
 */
import Link from 'next/link';

/** The project's site and source: the same for every deployment of the hub, whatever its HUB_NAME. */
const PROJECT_SITE_URL = 'https://scapekeeper.com';
const SOURCE_URL = 'https://github.com/RedFirebreak/osrs-data-hub';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex flex-1 items-center justify-center px-4 py-10">{children}</main>
      <footer className="flex flex-col items-center gap-2 px-4 pb-6 text-center text-xs text-muted-foreground">
        <nav aria-label="About this site" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          <Link href="/privacy" className="underline-offset-4 hover:underline">
            Privacy: what the hub stores
          </Link>
          <a href={PROJECT_SITE_URL} className="underline-offset-4 hover:underline">
            scapekeeper.com
          </a>
          <a href={SOURCE_URL} className="underline-offset-4 hover:underline">
            Source on GitHub
          </a>
        </nav>
        <p>Not affiliated with or endorsed by Jagex Ltd.</p>
      </footer>
    </div>
  );
}
