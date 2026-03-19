/**
 * Supernoba Common Layer - 통합 Export
 *
 * 사용법:
 * import { getValkeyClient, CORS, response, getSecret } from '/opt/nodejs/index.mjs';
 *
 * 또는 개별 모듈 import:
 * import { getValkeyClient } from '/opt/nodejs/valkeyClient.mjs';
 * import { CORS, response } from '/opt/nodejs/corsHeaders.mjs';
 * import { getSecret } from '/opt/nodejs/secretsManager.mjs';
 */

// Valkey/Redis Client
export {
  getValkeyClient,
  closeAllValkeyClients,
  createLegacyClient,
} from './valkeyClient.mjs';

// CORS Headers & Response Helpers
export {
  CORS,
  response,
  handleOptions,
} from './corsHeaders.mjs';

// Social Links Utilities
export {
  detectPlatformFromUrl,
} from './socialLinks.mjs';

// AWS Secrets Manager Utilities
export {
  getSecret,
  getJsonSecret,
  getTwitterBearerToken,
  getYouTubeApiKey,
  getStripeSecretKey,
  getStripeWebhookSecret,
  getStripeTestSecretKey,
  getStripeTestWebhookSecret,
  clearSecretsCache,
  SecretNames,
} from './secretsManager.mjs';
