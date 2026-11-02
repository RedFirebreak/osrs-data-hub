/**
 * The public API (handoff §13) as the apps use it: keys and their authentication, the per-key
 * limits, and one read model per endpoint. Everything else in this folder is internal; tests import
 * it from its file.
 */
export { MAX_BULK_ACCOUNTS, MAX_BULK_ACCOUNTS_SERVICE } from './access';
export {
  apiAccountCategories,
  apiGetAccount,
  apiListAccounts,
  type ApiAccountDetail,
  type ApiAccountSummary,
} from './accounts';
export {
  COLLECTION_LOG_DEFAULT_LIMIT,
  COLLECTION_LOG_ITEM_MAX_LENGTH,
  COLLECTION_LOG_ITEM_MIN_LENGTH,
  COLLECTION_LOG_LOOKUP_ITEMS,
  COLLECTION_LOG_MAX_LIMIT,
  COLLECTION_LOG_SOURCE_MAX_LENGTH,
  GUILD_COLLECTION_LOG_DEFAULT_LIMIT,
  GUILD_COLLECTION_LOG_MAX_LIMIT,
  apiAccountCollectionLog,
  apiGuildCollectionLog,
  type ApiAccountCollectionLog,
  type ApiGuildCollectionLog,
} from './collection-log';
export {
  DAY_MAX_DAYS,
  DAY_MAX_EVENTS,
  DAY_MAX_PLACES,
  DAY_TOP_EVENTS,
  apiDay,
  dayRange,
  placeStays,
  placesOf,
  type ApiDay,
  type ApiDayParams,
  type ApiPlace,
  type PlaceStay,
} from './day';
export { ApiError } from './errors';
export { apiHiscores, apiHiscoresMulti, type ApiHiscores } from './hiscores';
export {
  API_EVENTS_SETTLE_MS,
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  EVENT_SEARCH_MAX_LENGTH,
  EVENT_SEARCH_MIN_LENGTH,
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
  LOCATIONS_DEFAULT_HOURS,
  MAX_LOCATION_POINTS_PER_RESPONSE,
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
export {
  authenticateApiKey,
  type ApiAuthFailure,
  type ApiAuthOptions,
  type ApiPrincipal,
} from './key-auth';
export {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  forgetOAuthGrant,
  oauthTokenHash,
} from './oauth-grants';
export {
  OAUTH_KEY_FALLBACK_NAME,
  createOAuthKey,
  oauthClientInfo,
  oauthKeyName,
  type OAuthClientInfo,
} from './oauth-keys';
export {
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_NAME_MAX,
  ApiKeyError,
  CreateApiKeySchema,
  MAX_ACTIVE_KEYS,
  UpdateApiKeySchema,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
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
  deleteServiceKey,
  listServiceKeys,
  revokeServiceKey,
  updateServiceKey,
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
