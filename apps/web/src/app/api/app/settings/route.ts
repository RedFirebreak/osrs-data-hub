/**
 * The signed-in user's settings (handoff §12 Settings, §11 toast filter): toast filter and time zone.
 *
 * - GET → 200 `{ settings: UserSettings }` (the defaults when never saved).
 * - PATCH → body `UserSettingsPatchInput` (every field optional, unknown keys rejected) → 200
 *   `{ settings }` as stored. Invalid input → 400 `invalid_request` with `details: [{ path, message }]`
 *   (field errors from updateUserSettings' zod schema), a non-JSON body → 400 `invalid_json`.
 *
 * Session auth (401 JSON when signed out); PATCH also checks the Origin (CSRF, 403 `bad_origin`,
 * D-36). The live stream captures the toast filter when it opens: the Settings page reopens it after
 * saving.
 */
import { getDb } from '@hub/db';
import { getUserSettings, updateUserSettings } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { user } = await requireApiUser(request);
    const settings = await getUserSettings(getDb().db, user.id);
    return json(200, { settings });
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const body = await readJson(request);
    const settings = await updateUserSettings(getDb().db, user.id, body);
    return json(200, { settings });
  });
}
