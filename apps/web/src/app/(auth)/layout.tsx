/** Public sign-in pages: one centred column, no app chrome. */
import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex flex-1 items-center justify-center px-4 py-10">{children}</main>
      <footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
        <Link href="/privacy" className="underline-offset-4 hover:underline">
          Privacy: what the hub stores
        </Link>
      </footer>
    </div>
  );
}
