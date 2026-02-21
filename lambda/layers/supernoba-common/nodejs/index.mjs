/**
 * Supernoba Common Layer - 통합 Export
 *
 * 사용법:
 * import { getValkeyClient, CORS, response, buildSocialLinks, getSecret } from '/opt/nodejs/index.mjs';
 *
 * 또는 개별 모듈 import:
 * import { getValkeyClient } from '/opt/nodejs/valkeyClient.mjs';
 * import { CORS, response } from '/opt/nodejs/corsHeaders.mjs';
 * import { buildSocialLinks } from '/opt/nodejs/socialLinks.mjs';
 * import { getSecret, getAdminApiKey } from '/opt/nodejs/secretsManager.mjs';
 */

// Valkey/Redis Client
export {
  getValkeyClient,
  closeValkeyClient,
  closeAllValkeyClients,
  createLegacyClient,
} from './valkeyClient.mjs';

// CORS Headers & Response Helpers
export {
  CORS,
  response,
  handleOptions,
  getHttpMethod,
  ErrorCodes,
  errorByCode,
} from './corsHeaders.mjs';

// Social Links Utilities
export {
  PLATFORMS,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  PLATFORM_PATTERNS,
  buildSocialLinks,
  normalizePlatform,
  getPlatformColor,
  getPlatformLabel,
  detectPlatformFromUrl,
  getPlatformOptions,
  getValidSocialLinks,
  countSocialLinks,
} from './socialLinks.mjs';

// AWS Secrets Manager Utilities
export {
  getSecret,
  getJsonSecret,
  getAdminApiKey,
  getTwitterBearerToken,
  getYouTubeApiKey,
  getStripeSecretKey,
  getStripeWebhookSecret,
  clearSecretsCache,
  SecretNames,
} from './secretsManager.mjs';
