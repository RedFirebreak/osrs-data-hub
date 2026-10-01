/**
 * The public API (handoff §13) as the apps use it: keys and their authentication, the per-key
 * limits, and one read model per endpoint. Everything else in this folder is internal; tests import
 * it from its file.
 */
export { MAX_BULK_ACCOUNTS, MAX_BULK_ACCOUNTS_SERVICE } from './access';
export {
  apiGetAccount,
  apiListAccounts,
  type ApiAccountDetail,
  type ApiAccountSummary,
} from './accounts';
export { ApiError } from './errors';
export {
  API_EVENTS_SETTLE_MS,
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  apiEvents,
  apiEventsInRange,
  decodeEventsCursor,
  decodeEventsRangeCursor,
  encodeEventsCursor,
  encodeEventsRangeCursor,
  type ApiEvent,
} from './events';
export {
  HISTORY_DEFAULT_DAYS,
  apiEquipmentHistory,
  apiLocations,
  apiLocationsMulti,
  apiSessions,
  apiWealth,
  type ApiEquipmentHistory,
  type ApiLocations,
  type ApiLocationsMulti,
  type ApiSessions,
  type ApiWealth,
} from './history';
export { authenticateApiKey, type ApiAuthFailure, type ApiPrincipal } from './key-auth';
export {
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_NAME_MAX,
  ApiKeyError,
  CreateApiKeySchema,
  MAX_ACTIVE_KEYS,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInfo,
  type ApiKeyStatus,
} from './keys';
export {
  LEADERBOARD_PERIODS,
  LOOT_LEADERBOARD_DEFAULT_LIMIT,
  LOOT_LEADERBOARD_MAX_LIMIT,
  apiLeaderboardGains,
  apiLootLeaderboard,
  type ApiLeaderboards,
  type ApiLootLeaderboard,
} from './leaderboards';
export {
  API_RATE_LIMIT,
  API_RATE_WINDOW_MS,
  FAILED_AUTH_LIMIT,
  FAILED_AUTH_WINDOW_MS,
  MAX_KEY_RATE_LIMIT,
  SERVICE_KEY_RATE_LIMIT,
  SNAPSHOT_RATE_LIMIT,
  SNAPSHOT_RATE_WINDOW_MS,
  checkApiRate,
  checkAuthFailures,
  createApiLimits,
  recordAuthFailure,
  type ApiLimits,
  type ApiRateHeaders,
} from './limits';
export { apiMe, type ApiMe } from './me';
export { apiMember, type ApiMember } from './members';
// The parameter rules (id shape, ranges, list caps) are the web layer's too: all of it is public.
export * from './params';
export {
  createServiceKey,
  listServiceKeys,
  revokeServiceKey,
  type ServiceKeyInfo,
} from './service-keys';
export {
  SNAPSHOT_SINCE_OVERLAP_MS,
  apiSnapshot,
  etagMatches,
  type ApiSnapshotAccount,
} from './snapshot';
export type {
  ApiEquipment,
  ApiInventory,
  ApiLocation,
  ApiPresence,
  ApiSkills,
  ApiVitals,
} from './state';
export type { ApiItem, ApiOwner, ApiSection } from './types';
export {
  GAINS_PERIODS,
  MAX_XP_SKILLS,
  XP_DEFAULT_DAYS,
  XP_RESOLUTIONS,
  apiGains,
  apiXp,
  apiXpMulti,
  type ApiGains,
  type ApiXpMulti,
  type ApiXpSeries,
} from './xp';
