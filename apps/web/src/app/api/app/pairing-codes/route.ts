/**
 * POST /api/app/pairing-codes — a pairing code for the onboarding wizard (handoff §6.2).
 *
 * Body `{ label?: string | null }` (the optional device label; unknown keys are rejected; an empty
 * body counts as `{}`) → 201 `{ id, code, expiresAt, baseUrl }`:
 * - `code`: 5 ASCII digits as a string, leading zeros kept (PLUGIN-6);
 * - `expiresAt`: ISO-8601, PAIRING_CODE_TTL_SECONDS from now;
 * - `baseUrl`: APP_URL's origin, the exact URL the player pastes into the plugin (D-26). Never built
 *   from request.url (NEXT-2): that is the server's bind address, and a URL without its https://
 *   scheme fails silently in the plugin (PLUGIN-13).
 *
 * The user's oldest active codes are retired so at most 3 stay active (createPairingCode), so
 * "Regenerate" never runs into a limit. Session auth (401) and an Origin check (403, D-36).
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { createPairingCode } from '@hub/server';
import { z } from 'zod';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { labelInput } from '../devices/label';

const createSchema = z.strictObject({ label: labelInput.nullish() });

/** What POST answers (201). */
interface CreatedPairingCodeResponse {
  id: string;
  code: string;
  expiresAt: string;
  baseUrl: string;
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    // The body is optional: none at all counts as `{}`.
    const { label } = createSchema.parse(await readJson(request, { emptyAs: {} }));
    const config = getConfig();
    const created = await createPairingCode(getDb().db, {
      userId: user.id,
      label: label ?? null,
      ttlSeconds: config.pairingCodeTtlSeconds,
    });
    const body: CreatedPairingCodeResponse = {
      id: created.id,
      code: created.code,
      expiresAt: created.expiresAt.toISOString(),
      baseUrl: config.appOrigin,
    };
    return json(201, body);
  });
}
