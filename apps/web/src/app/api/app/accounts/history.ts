import { ApiError } from '@/lib/http';

/** The one 404 of the account routes: unknown, invisible and impossible ids look the same. */
export function accountNotFound(): ApiError {
  return new ApiError(404, 'not_found', 'Account not found.');
}
