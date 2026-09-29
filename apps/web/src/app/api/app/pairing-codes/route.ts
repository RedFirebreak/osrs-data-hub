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
import {
  API_MAX_BODY_BYTES,
  ApiError,
  assertSameOrigin,
  handleApi,
  json,
  readBodyCapped,
} from '@/lib/http';
import { requireApiUser } from '@/lib/session';

/** Longest label accepted before normalization (the stored label is cut to 64 characters). */
const LABEL_INPUT_MAX = 256;

const createSchema = z.strictObject({
  label: z.string().max(LABEL_INPUT_MAX).nullish(),
});

/** What POST answers (201). */
interface CreatedPairingCodeResponse {
  id: string;
  code: string;
  expiresAt: string;
  baseUrl: string;
}

/** The JSON body, `{}` when there is none (readJson would call an empty body invalid JSON). */
async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await readBodyCapped(request, API_MAX_BODY_BYTES);
  if (text === null) throw new ApiError(413, 'payload_too_large', 'The request body is too large.');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { label } = createSchema.parse(await readOptionalJson(request));
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
