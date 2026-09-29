/**
 * The body of PATCH /api/app/accounts/[publicId]/sharing: one sharing or ownership change, discriminated
 * on `action` (strict: unknown keys are refused, D-10). Client code imports the type only
 * (`import type`), so zod and @hub/core stay out of its bundle (NEXT-12).
 */
import { AUDIENCES, CATEGORIES } from '@hub/core';
import { z } from 'zod';

/** Better Auth user ids (users.id): opaque strings. */
const userId = z.string().min(1).max(255);
const category = z.enum(CATEGORIES);

export const sharingChangeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('audience'), category, audience: z.enum(AUDIENCES) }),
  z.strictObject({ action: z.enum(['grant', 'revoke']), category, userId }),
  z.strictObject({ action: z.literal('transfer'), userId }),
  z.strictObject({ action: z.literal('claim') }),
  z.strictObject({ action: z.enum(['block', 'unblock', 'remove']), userId }),
]);

export type SharingChange = z.infer<typeof sharingChangeSchema>;
