/**
 * AWS Secrets Manager Utility for Lambda
 * Secure credential management with caching
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Cache for secrets (persists across Lambda invocations in warm start)
const secretsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Lazy initialization
let client = null;

function getClient() {
  if (!client) {
    client = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'ap-northeast-2',
    });
  }
  return client;
}

/**
 * Get a secret from AWS Secrets Manager with caching
 * @param {string} secretName - The secret name or ARN
 * @param {string} [envFallback] - Fallback environment variable value
 * @returns {Promise<string>} - The secret value
 */
export async function getSecret(secretName, envFallback) {
  // Check cache first
  const cached = secretsCache.get(secretName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await getClient().send(command);
    const secretValue = response.SecretString || '';

    // Cache the result
    secretsCache.set(secretName, {
      value: secretValue,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return secretValue;
  } catch (error) {
    console.warn(`[Secrets] Failed to fetch ${secretName}:`, error.message);

    // Fallback to provided value
    if (envFallback !== undefined) {
      return envFallback;
    }

    throw error;
  }
}

/**
 * Get JSON secret and parse it
 * @param {string} secretName - The secret name or ARN
 * @param {string} [envFallback] - Fallback JSON string
 * @returns {Promise<object>} - Parsed JSON object
 */
export async function getJsonSecret(secretName, envFallback) {
  const value = await getSecret(secretName, envFallback);
  return JSON.parse(value);
}

/**
 * Get admin API key with secure fallback
 * @returns {Promise<string>} - The admin API key
 */
export async function getAdminApiKey() {
  return getSecret('supernoba/admin-api-key', process.env.ADMIN_API_KEY);
}

/**
 * Get Twitter bearer token with secure fallback
 * @returns {Promise<string>} - The Twitter bearer token
 */
export async function getTwitterBearerToken() {
  return getSecret('supernoba/twitter-bearer-token', process.env.TWITTER_BEARER_TOKEN);
}

/**
 * Get YouTube API key with secure fallback
 * @returns {Promise<string>} - The YouTube API key
 */
export async function getYouTubeApiKey() {
  return getSecret('supernoba/youtube-api-key', process.env.YOUTUBE_API_KEY);
}

/**
 * Get Stripe secret key with secure fallback
 * @returns {Promise<string>} - The Stripe secret key
 */
export async function getStripeSecretKey() {
  return getSecret('supernoba/stripe-secret-key', process.env.STRIPE_SECRET_KEY);
}

/**
 * Get Stripe webhook secret with secure fallback
 * @returns {Promise<string>} - The Stripe webhook signing secret
 */
export async function getStripeWebhookSecret() {
  return getSecret('supernoba/stripe-webhook-secret', process.env.STRIPE_WEBHOOK_SECRET);
}

/**
 * Get Stripe TEST secret key with secure fallback
 * @returns {Promise<string>} - The Stripe test secret key
 */
export async function getStripeTestSecretKey() {
  return getSecret('supernoba/stripe-secret-key-test', process.env.STRIPE_TEST_SECRET_KEY);
}

/**
 * Get Stripe TEST webhook secret with secure fallback
 * @returns {Promise<string>} - The Stripe test webhook signing secret
 */
export async function getStripeTestWebhookSecret() {
  return getSecret('supernoba/stripe-webhook-secret-test', process.env.STRIPE_TEST_WEBHOOK_SECRET);
}

/**
 * Clear the secrets cache
 */
export function clearSecretsCache() {
  secretsCache.clear();
}

/**
 * Secret names constants
 */
export const SecretNames = {
  ADMIN_API_KEY: 'supernoba/admin-api-key',
  TWITTER_BEARER_TOKEN: 'supernoba/twitter-bearer-token',
  YOUTUBE_API_KEY: 'supernoba/youtube-api-key',
  SUPERNOBA_API_KEY: 'supernoba/api-key',
  STRIPE_SECRET_KEY: 'supernoba/stripe-secret-key',
  STRIPE_WEBHOOK_SECRET: 'supernoba/stripe-webhook-secret',
  STRIPE_TEST_SECRET_KEY: 'supernoba/stripe-secret-key-test',
  STRIPE_TEST_WEBHOOK_SECRET: 'supernoba/stripe-webhook-secret-test',
};

export default {
  getSecret,
  getJsonSecret,
  getAdminApiKey,
  getTwitterBearerToken,
  getYouTubeApiKey,
  getStripeSecretKey,
  getStripeWebhookSecret,
  getStripeTestSecretKey,
  getStripeTestWebhookSecret,
  clearSecretsCache,
  SecretNames,
};
