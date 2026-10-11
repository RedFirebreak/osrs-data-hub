/**
 * The link to the guild's live map (D-115): an admin setting in hub_settings under 'map_link', read
 * by the signed-in layout for the top bar's "Map", and changed on Admin → Settings. No row, or a
 * stored value this version can't read, means DEFAULT_MAP_LINK (off).
 */
import { DEFAULT_MAP_LINK, parseMapUrl, type MapLink } from '@hub/core';
import { hubSettings, type Db, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit';

const MAP_LINK_KEY = 'map_link';

const MAP_URL_MESSAGE = 'An http or https address, such as https://map.example.com';

/**
 * The setting as the admin page sends it (strict, D-10): the address normalised (parseMapUrl), an
 * empty one as null; turning the link on needs an address.
 */
export const MapLinkSchema = z
  .strictObject({
    enabled: z.boolean(),
    url: z
      .string()
      .nullable()
      .transform((text, ctx) => {
        if (text === null || text.trim() === '') return null;
        const url = parseMapUrl(text);
        if (url === null) ctx.addIssue({ code: 'custom', message: MAP_URL_MESSAGE });
        return url;
      }),
  })
  .refine((link) => !link.enabled || link.url !== null, {
    message: 'The map needs an address before it can be turned on',
    path: ['url'],
  });

/** The stored value, read leniently: unknown keys ignored, missing or unusable ones off. */
const StoredMapLinkSchema = z
  .object({ enabled: z.boolean(), url: z.string().nullable() })
  .partial();

/** The current setting. One primary-key read per call, so a change shows on the next request. */
export async function getMapLink(db: DbOrTx): Promise<MapLink> {
  const [row] = await db
    .select({ value: hubSettings.value })
    .from(hubSettings)
    .where(eq(hubSettings.key, MAP_LINK_KEY));
  const parsed = StoredMapLinkSchema.safeParse(row?.value);
  const stored = parsed.success ? parsed.data : {};
  const url = typeof stored.url === 'string' ? parseMapUrl(stored.url) : null;
  return { enabled: (stored.enabled ?? DEFAULT_MAP_LINK.enabled) && url !== null, url };
}

/** Stores a new setting (admin only; the caller checks). Audited as 'hub.map_link_changed'. */
export async function setMapLink(
  db: Db,
  opts: { link: z.input<typeof MapLinkSchema>; actorUserId: string },
): Promise<MapLink> {
  const link = MapLinkSchema.parse(opts.link);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(hubSettings)
      .values({ key: MAP_LINK_KEY, value: link, updatedAt: now, updatedBy: opts.actorUserId })
      .onConflictDoUpdate({
        target: hubSettings.key,
        set: { value: link, updatedAt: now, updatedBy: opts.actorUserId },
      });
    await audit(tx, {
      actorUserId: opts.actorUserId,
      action: 'hub.map_link_changed',
      targetType: 'hub',
      targetId: MAP_LINK_KEY,
      meta: link,
    });
  });
  return link;
}
