/** One play session of an account, by id, for a Metrics session timeline. */
import { playSessions, type DbOrTx } from '@hub/db';
import { and, eq } from 'drizzle-orm';

export interface SessionRow {
  id: string;
  start: number;
  /** Its end, or its last payload while it is open. */
  end: number;
  open: boolean;
}

/** The session, or null when the account has no session with that id. */
export async function getSession(
  db: DbOrTx,
  accountId: number,
  sessionId: string,
): Promise<SessionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const [row] = await db
    .select({
      id: playSessions.id,
      startedAt: playSessions.startedAt,
      endedAt: playSessions.endedAt,
      lastSeenAt: playSessions.lastSeenAt,
    })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.accountId, accountId)));
  if (!row) return null;
  return {
    id: row.id,
    start: row.startedAt.getTime(),
    end: (row.endedAt ?? row.lastSeenAt).getTime(),
    open: row.endedAt === null,
  };
}
