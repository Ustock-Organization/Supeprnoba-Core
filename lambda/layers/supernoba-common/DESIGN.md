# Supernoba Lambda Layer Architecture Design

## Executive Summary

This document outlines the design for a shared Lambda Layer (`supernoba-common`) to eliminate code duplication across 25+ Lambda functions in the Supernoba trading platform. The layer will provide unified implementations for Redis/Valkey connections, DynamoDB clients, CORS headers, response helpers, and shared business logic.

---

## 1. Current State Analysis

### 1.1 Redis/Valkey Configuration Duplication

**14 Lambda functions** contain duplicated Redis connection code with varying configurations:

| Lambda Function | Host Source | TLS | Timeout | Retry Strategy | Notes |
|----------------|-------------|-----|---------|----------------|-------|
| Supernoba-connect-handler | env or hardcoded | conditional | 3000ms | null after 1 | lazyConnect=true |
| Supernoba-disconnect-handler | env or hardcoded | conditional | 3000ms | null after 1 | lazyConnect=true |
| Supernoba-subscribe-handler | env or hardcoded | conditional | 5000ms | exponential (2x) | lazyConnect=true |
| Supernoba-notifier | env only | conditional | 5000ms | linear (1000ms, 2x) | lazyConnect=true |
| Supernoba-cleanup-handler | env or hardcoded | conditional | 5000ms | exponential (2x, max 3) | lazyConnect=true |
| Supernoba-admin-mm | env or hardcoded | always TLS | 5000ms | 3 retries | Different host (backup cache) |
| Supernoba-admin-users | env only | always TLS | 5000ms | 3 retries | |
| Supernoba-admin-stats | env only | always TLS | 5000ms | 3 retries | |
| Supernoba-admin-core | env only | always TLS | varies | varies | |
| Supernoba-admin-ws-handler | env or hardcoded | conditional | 10000ms | linear (1000ms, 2x) | Two Redis instances |
| Supernoba-symbol-admin | env or hardcoded | varies | varies | varies | |
| Supernoba-approval-handler | env or hardcoded | varies | varies | varies | |
| Supernoba-admin | env or hardcoded | varies | varies | varies | |
| Supernoba-admin-monitoring | env or hardcoded | varies | varies | varies | |

**Key Findings:**
- **4 Valkey cache instances** are used (EC2: localhost ports, Lambda: ElastiCache endpoints):
  1. Depth Cache (포트 6379): 실시간 호가, 티커, OHLC, 전일종가
  2. Candle Cache (포트 6380): 1분봉 활성/마감 데이터
  3. Backup Cache (포트 6381): 오더북 스냅샷, Kinesis 체크포인트, 랭킹
  4. Operating Cache (포트 6382): WebSocket 연결, 구독, MM, 종목 관리

- **Inconsistent TLS handling**: Some functions use conditional TLS based on env var, others always enable TLS

- **Varied retry strategies**: From "no retry" to exponential backoff with 3 attempts

### 1.2 CORS Header Variations

**21 Lambda functions** define CORS headers with **8 different variations**:

| Variation | Methods | Headers | Usage Count |
|-----------|---------|---------|-------------|
| Type A | GET, POST, PUT, DELETE, OPTIONS | Content-Type, Authorization | 7 |
| Type B | GET, POST, OPTIONS | Content-Type, Authorization | 5 |
| Type C | GET, OPTIONS | Content-Type, Authorization | 2 |
| Type D | OPTIONS, GET | Content-Type, Authorization, x-api-key | 1 |
| Type E | GET, PUT, POST, DELETE, OPTIONS | Content-Type, Authorization | 1 |
| Type F | GET, POST, DELETE, OPTIONS | Content-Type, Authorization | 1 |
| Type G | Only Allow-Origin | - | 2 |
| Type H | GET, OPTIONS | Content-Type only | 1 |

**All functions share**: `Access-Control-Allow-Origin: '*'`

### 1.3 buildSocialLinks Function Duplication

**Identical 42-line function** exists in two locations:

1. **Backend**: `C:\develop\liquibook\lambda\Supernoba-asset-handler\index.mjs` (lines 345-386)
2. **Frontend**: `C:\develop\Supernoba-front\src\services\SymbolService.js` (lines 17-58)

Both implementations:
- Initialize links object with 7 platform keys (youtube, twitter, instagram, twitch, tiktok, chzzk, afreecatv)
- Map platform string to appropriate link field using switch statement
- Handle case-insensitive platform names (X/TWITTER)

---

## 2. Proposed Lambda Layer Structure

### 2.1 Directory Layout

```
/opt/nodejs/
|-- index.mjs              # Re-exports all modules
|-- valkeyClient.mjs       # Unified Redis/Valkey client factory
|-- ddbClient.mjs          # DynamoDB DocumentClient singleton
|-- corsHeaders.mjs        # Standardized CORS headers
|-- responseHelpers.mjs    # HTTP response helper functions
|-- socialLinks.mjs        # buildSocialLinks function
|-- package.json           # Layer dependencies
```

### 2.2 Module Specifications

---

## 3. Module Implementations

### 3.1 valkeyClient.mjs

```javascript
/**
 * Unified Redis/Valkey Client Factory
 *
 * Provides pre-configured Redis clients for different use cases:
 * - depthCache: Matching engine data, market depth
 * - backupCache: MM configurations, admin data
 * - generalCache: General purpose caching
 *
 * Features:
 * - Lazy connection (connect on first use)
 * - Automatic reconnection with exponential backoff
 * - TLS support via environment variable
 * - Connection pooling per Lambda instance
 *
 * Environment Variables:
 * - VALKEY_HOST: Primary cache host (depth cache)
 * - VALKEY_BACKUP_HOST: Secondary cache host (backup/MM cache)
 * - VALKEY_PORT: Redis port (default: 6379)
 * - VALKEY_TLS: Enable TLS ('true' to enable)
 */

import Redis from 'ioredis';

// Cache host configurations
const CACHE_HOSTS = {
  depth: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  backup: process.env.VALKEY_BACKUP_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com',
  depthCluster: process.env.VALKEY_CLUSTER_HOST || 'master.supernoba-depth-cache.5vrxzz.apn2.cache.amazonaws.com',
};

const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

// Client instance cache (singleton per Lambda instance)
const clientCache = new Map();

/**
 * Retry strategy configurations
 */
const RETRY_STRATEGIES = {
  // No retry - fail fast for latency-sensitive operations
  none: () => null,

  // Linear retry - simple fixed delay
  linear: (maxRetries = 2, delay = 1000) => (times) => {
    if (times > maxRetries) return null;
    return delay;
  },

  // Exponential backoff - increasing delays
  exponential: (maxRetries = 3, baseDelay = 100, maxDelay = 1000) => (times) => {
    if (times > maxRetries) return null;
    return Math.min(baseDelay * Math.pow(2, times - 1), maxDelay);
  },
};

/**
 * Preset configurations for different use cases
 */
const PRESETS = {
  // WebSocket handlers - fast fail, no blocking
  websocket: {
    host: CACHE_HOSTS.depth,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: RETRY_STRATEGIES.none(),
    lazyConnect: true,
    enableOfflineQueue: false,
  },

  // Background processors - allow retries
  processor: {
    host: CACHE_HOSTS.depth,
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    retryStrategy: RETRY_STRATEGIES.exponential(3, 100, 500),
    lazyConnect: true,
    enableOfflineQueue: true,
  },

  // Admin operations - reliable with retries
  admin: {
    host: CACHE_HOSTS.backup,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
    retryStrategy: RETRY_STRATEGIES.linear(2, 1000),
    lazyConnect: true,
    enableOfflineQueue: true,
  },

  // Market maker - backup cache
  marketMaker: {
    host: CACHE_HOSTS.backup,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
    retryStrategy: RETRY_STRATEGIES.exponential(2, 200, 1000),
    lazyConnect: true,
    enableOfflineQueue: false,
  },

  // Cleanup/batch jobs - longer timeouts
  batch: {
    host: CACHE_HOSTS.depth,
    connectTimeout: 10000,
    maxRetriesPerRequest: 2,
    retryStrategy: RETRY_STRATEGIES.exponential(3, 200, 1000),
    lazyConnect: true,
    enableOfflineQueue: true,
  },
};

/**
 * Create a Redis client with the specified configuration
 *
 * @param {string} preset - Preset name: 'websocket', 'processor', 'admin', 'marketMaker', 'batch'
 * @param {Object} overrides - Override specific options
 * @returns {Redis} Configured Redis client
 */
export function createValkeyClient(preset = 'websocket', overrides = {}) {
  const config = { ...PRESETS[preset], ...overrides };

  const options = {
    host: config.host,
    port: VALKEY_PORT,
    tls: VALKEY_TLS ? {} : undefined,
    connectTimeout: config.connectTimeout,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    retryStrategy: config.retryStrategy,
    lazyConnect: config.lazyConnect,
    enableOfflineQueue: config.enableOfflineQueue ?? false,
  };

  const client = new Redis(options);

  // Silent error handler to prevent unhandled rejections
  client.on('error', (err) => {
    // Suppress connection errors in logs (handled by retry strategy)
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
      console.error(`[ValkeyClient] Error:`, err.message);
    }
  });

  return client;
}

/**
 * Get a singleton Redis client for the specified preset
 * Reuses existing connections within the same Lambda instance
 *
 * @param {string} preset - Preset name
 * @returns {Redis} Cached Redis client
 */
export function getValkeyClient(preset = 'websocket') {
  if (!clientCache.has(preset)) {
    clientCache.set(preset, createValkeyClient(preset));
  }
  return clientCache.get(preset);
}

/**
 * Ensure Redis client is connected
 *
 * @param {Redis} client - Redis client instance
 * @returns {Promise<boolean>} Connection status
 */
export async function ensureConnected(client) {
  if (client.status === 'ready') return true;

  try {
    if (client.status === 'wait') {
      await client.connect();
    }
    return client.status === 'ready';
  } catch (err) {
    console.error('[ValkeyClient] Connection failed:', err.message);
    return false;
  }
}

/**
 * Close all cached clients (for graceful shutdown)
 */
export async function closeAllClients() {
  const closePromises = [];
  for (const [key, client] of clientCache) {
    closePromises.push(client.quit().catch(() => {}));
  }
  await Promise.all(closePromises);
  clientCache.clear();
}

// Export presets and hosts for custom configurations
export { PRESETS, CACHE_HOSTS, RETRY_STRATEGIES };

// Default export for convenience
export default {
  createValkeyClient,
  getValkeyClient,
  ensureConnected,
  closeAllClients,
  PRESETS,
  CACHE_HOSTS,
  RETRY_STRATEGIES,
};
```

---

### 3.2 ddbClient.mjs

```javascript
/**
 * DynamoDB DocumentClient Singleton
 *
 * Provides pre-configured DynamoDB DocumentClient with:
 * - Single instance per Lambda execution context
 * - Optimized marshalling options
 * - Table name constants
 *
 * Environment Variables:
 * - AWS_REGION: AWS region (default: ap-northeast-2)
 * - ORDERS_TABLE: Orders table name
 * - SYMBOLS_TABLE: Symbols table name
 * - HOLDINGS_TABLE: Holdings table name
 * - WALLETS_TABLE: Wallets table name
 * - USER_CACHE_TABLE: User cache table name
 * - AUDIT_LOGS_TABLE: Audit logs table name
 * - SETTINGS_TABLE: Settings table name
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

// Table name constants
export const TABLES = {
  ORDERS: process.env.ORDERS_TABLE || 'supernoba-orders',
  SYMBOLS: process.env.SYMBOLS_TABLE || 'supernoba-symbols',
  HOLDINGS: process.env.HOLDINGS_TABLE || 'supernoba-holdings',
  WALLETS: process.env.WALLETS_TABLE || 'supernoba-wallets',
  USER_CACHE: process.env.USER_CACHE_TABLE || 'supernoba-user-cache',
  AUDIT_LOGS: process.env.AUDIT_LOGS_TABLE || 'supernoba-audit-logs',
  SETTINGS: process.env.SETTINGS_TABLE || 'supernoba-settings',
};

// DynamoDB client singleton
let ddbClient = null;
let docClient = null;

/**
 * Get DynamoDB DocumentClient singleton
 *
 * @returns {DynamoDBDocumentClient} Configured DocumentClient
 */
export function getDynamoDBClient() {
  if (!docClient) {
    ddbClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'ap-northeast-2',
    });

    docClient = DynamoDBDocumentClient.from(ddbClient, {
      marshallOptions: {
        convertEmptyValues: false,
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
      unmarshallOptions: {
        wrapNumbers: false,
      },
    });
  }

  return docClient;
}

/**
 * Convenience wrapper for common DynamoDB operations
 */
export const ddb = {
  get client() {
    return getDynamoDBClient();
  },

  async get(tableName, key) {
    return getDynamoDBClient().send(new GetCommand({
      TableName: tableName,
      Key: key,
    }));
  },

  async put(tableName, item, options = {}) {
    return getDynamoDBClient().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ...options,
    }));
  },

  async update(tableName, key, updateExpression, expressionValues, options = {}) {
    return getDynamoDBClient().send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionValues,
      ...options,
    }));
  },

  async delete(tableName, key, options = {}) {
    return getDynamoDBClient().send(new DeleteCommand({
      TableName: tableName,
      Key: key,
      ...options,
    }));
  },

  async query(tableName, keyCondition, expressionValues, options = {}) {
    return getDynamoDBClient().send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ...options,
    }));
  },

  async scan(tableName, options = {}) {
    return getDynamoDBClient().send(new ScanCommand({
      TableName: tableName,
      ...options,
    }));
  },
};

// Re-export command classes for advanced usage
export {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
  BatchWriteCommand,
};

export default {
  getDynamoDBClient,
  ddb,
  TABLES,
};
```

---

### 3.3 corsHeaders.mjs

```javascript
/**
 * Standardized CORS Headers
 *
 * Provides consistent CORS header configurations for all Lambda functions.
 * Supports different presets for various endpoint requirements.
 *
 * Usage:
 *   import { CORS, withCors } from '/opt/nodejs/corsHeaders.mjs';
 *
 *   // Use preset headers
 *   return { statusCode: 200, headers: CORS.FULL, body: '...' };
 *
 *   // Use helper function
 *   return withCors(200, { data: 'response' });
 */

/**
 * CORS header presets
 */
export const CORS = {
  // Full CRUD operations - Admin endpoints
  FULL: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  },

  // Read-write operations - Standard API endpoints
  STANDARD: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  },

  // Read-only operations - Public data endpoints
  READONLY: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  },

  // With API key support - External integrations
  WITH_API_KEY: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  },

  // Minimal - WebSocket or internal endpoints
  MINIMAL: {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  },
};

/**
 * Create a Lambda response with CORS headers
 *
 * @param {number} statusCode - HTTP status code
 * @param {Object|string} body - Response body (will be JSON.stringify'd if object)
 * @param {Object} headers - CORS preset or custom headers (default: STANDARD)
 * @returns {Object} Lambda response object
 */
export function withCors(statusCode, body, headers = CORS.STANDARD) {
  return {
    statusCode,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * Create an OPTIONS preflight response
 *
 * @param {Object} headers - CORS headers preset (default: FULL)
 * @returns {Object} Lambda response for OPTIONS
 */
export function preflightResponse(headers = CORS.FULL) {
  return {
    statusCode: 200,
    headers,
    body: '',
  };
}

/**
 * Merge custom headers with a CORS preset
 *
 * @param {Object} preset - Base CORS preset
 * @param {Object} custom - Custom headers to merge
 * @returns {Object} Merged headers
 */
export function mergeHeaders(preset, custom = {}) {
  return { ...preset, ...custom };
}

export default {
  CORS,
  withCors,
  preflightResponse,
  mergeHeaders,
};
```

---

### 3.4 responseHelpers.mjs

```javascript
/**
 * HTTP Response Helper Functions
 *
 * Provides standardized response creation for Lambda functions.
 * Integrates with CORS headers and common error handling patterns.
 *
 * Usage:
 *   import { ok, error, notFound, forbidden } from '/opt/nodejs/responseHelpers.mjs';
 *
 *   return ok({ users: [...] });
 *   return error(400, 'Missing required field');
 *   return notFound('User not found');
 */

import { CORS, withCors } from './corsHeaders.mjs';

/**
 * Success response (200 OK)
 *
 * @param {Object} data - Response data
 * @param {Object} headers - Optional custom headers
 * @returns {Object} Lambda response
 */
export function ok(data, headers = CORS.STANDARD) {
  return withCors(200, data, headers);
}

/**
 * Created response (201 Created)
 *
 * @param {Object} data - Created resource data
 * @param {Object} headers - Optional custom headers
 * @returns {Object} Lambda response
 */
export function created(data, headers = CORS.STANDARD) {
  return withCors(201, data, headers);
}

/**
 * Error response with custom status code
 *
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} errorCode - Optional error code
 * @param {Object} headers - Optional custom headers
 * @returns {Object} Lambda response
 */
export function error(statusCode, message, errorCode = null, headers = CORS.STANDARD) {
  const body = { error: errorCode || 'ERROR', message };
  return withCors(statusCode, body, headers);
}

/**
 * Bad Request response (400)
 *
 * @param {string} message - Error message
 * @param {string} errorCode - Optional error code
 * @returns {Object} Lambda response
 */
export function badRequest(message, errorCode = 'BAD_REQUEST') {
  return error(400, message, errorCode);
}

/**
 * Unauthorized response (401)
 *
 * @param {string} message - Error message (default: 'Authentication required')
 * @returns {Object} Lambda response
 */
export function unauthorized(message = 'Authentication required') {
  return error(401, message, 'UNAUTHORIZED');
}

/**
 * Forbidden response (403)
 *
 * @param {string} message - Error message (default: 'Access denied')
 * @returns {Object} Lambda response
 */
export function forbidden(message = 'Access denied') {
  return error(403, message, 'FORBIDDEN');
}

/**
 * Not Found response (404)
 *
 * @param {string} message - Error message (default: 'Resource not found')
 * @returns {Object} Lambda response
 */
export function notFound(message = 'Resource not found') {
  return error(404, message, 'NOT_FOUND');
}

/**
 * Conflict response (409)
 *
 * @param {string} message - Error message
 * @returns {Object} Lambda response
 */
export function conflict(message) {
  return error(409, message, 'CONFLICT');
}

/**
 * Internal Server Error response (500)
 *
 * @param {string} message - Error message (default: 'Internal server error')
 * @returns {Object} Lambda response
 */
export function serverError(message = 'Internal server error') {
  return error(500, message, 'SERVER_ERROR');
}

/**
 * Service Unavailable response (503)
 *
 * @param {string} message - Error message
 * @returns {Object} Lambda response
 */
export function serviceUnavailable(message = 'Service temporarily unavailable') {
  return error(503, message, 'SERVICE_UNAVAILABLE');
}

/**
 * Parse and validate request body
 *
 * @param {Object} event - Lambda event object
 * @param {string[]} requiredFields - Required field names
 * @returns {{ success: boolean, body?: Object, error?: Object }} Parse result
 */
export function parseBody(event, requiredFields = []) {
  try {
    const body = typeof event.body === 'string'
      ? JSON.parse(event.body)
      : event.body || {};

    // Check required fields
    const missingFields = requiredFields.filter(field =>
      body[field] === undefined || body[field] === null
    );

    if (missingFields.length > 0) {
      return {
        success: false,
        error: badRequest(`Missing required fields: ${missingFields.join(', ')}`),
      };
    }

    return { success: true, body };
  } catch (e) {
    return {
      success: false,
      error: badRequest('Invalid JSON in request body'),
    };
  }
}

export default {
  ok,
  created,
  error,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serverError,
  serviceUnavailable,
  parseBody,
};
```

---

### 3.5 socialLinks.mjs

```javascript
/**
 * Social Links Builder
 *
 * Generates standardized social media link objects for creator profiles.
 * Shared between backend Lambda functions and frontend applications.
 *
 * Supported Platforms:
 * - YouTube
 * - Twitter/X
 * - Instagram
 * - Twitch
 * - TikTok
 * - Chzzk (Korean streaming)
 * - AfreecaTV (Korean streaming)
 */

/**
 * Supported social platforms
 */
export const PLATFORMS = {
  YOUTUBE: 'YOUTUBE',
  TWITTER: 'TWITTER',
  X: 'X',
  INSTAGRAM: 'INSTAGRAM',
  TWITCH: 'TWITCH',
  TIKTOK: 'TIKTOK',
  CHZZK: 'CHZZK',
  AFREECATV: 'AFREECATV',
  ETC: 'ETC',
};

/**
 * Platform to link key mapping
 */
const PLATFORM_KEY_MAP = {
  YOUTUBE: 'youtube',
  TWITTER: 'twitter',
  X: 'twitter',  // X maps to twitter
  INSTAGRAM: 'instagram',
  TWITCH: 'twitch',
  TIKTOK: 'tiktok',
  CHZZK: 'chzzk',
  AFREECATV: 'afreecatv',
};

/**
 * Build social links object from platform and creator URL
 *
 * @param {string} platform - Platform name (e.g., 'YOUTUBE', 'TWITTER', 'X')
 * @param {string} creatorUrl - Creator's profile URL
 * @param {Object} existingSocialLinks - Existing social links to merge
 * @returns {Object} Social links object with all platform keys
 *
 * @example
 * const links = buildSocialLinks('YOUTUBE', 'https://youtube.com/@creator');
 * // Returns: { youtube: 'https://youtube.com/@creator', twitter: null, ... }
 */
export function buildSocialLinks(platform, creatorUrl, existingSocialLinks = {}) {
  // Initialize with existing links or null values
  const links = {
    youtube: existingSocialLinks?.youtube || null,
    twitter: existingSocialLinks?.twitter || null,
    instagram: existingSocialLinks?.instagram || null,
    twitch: existingSocialLinks?.twitch || null,
    tiktok: existingSocialLinks?.tiktok || null,
    chzzk: existingSocialLinks?.chzzk || null,
    afreecatv: existingSocialLinks?.afreecatv || null,
  };

  // Map creator URL to appropriate platform key
  if (creatorUrl && platform) {
    const normalizedPlatform = platform.toUpperCase();
    const linkKey = PLATFORM_KEY_MAP[normalizedPlatform];

    if (linkKey) {
      links[linkKey] = creatorUrl;
    }
  }

  return links;
}

/**
 * Get all non-null social links as an array
 *
 * @param {Object} socialLinks - Social links object
 * @returns {Array<{platform: string, url: string}>} Array of active links
 */
export function getActiveSocialLinks(socialLinks) {
  if (!socialLinks) return [];

  return Object.entries(socialLinks)
    .filter(([, url]) => url !== null && url !== undefined && url !== '')
    .map(([platform, url]) => ({ platform, url }));
}

/**
 * Check if creator has any social links
 *
 * @param {Object} socialLinks - Social links object
 * @returns {boolean} True if at least one link exists
 */
export function hasSocialLinks(socialLinks) {
  return getActiveSocialLinks(socialLinks).length > 0;
}

/**
 * Validate social media URL format
 *
 * @param {string} platform - Platform name
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL appears valid for the platform
 */
export function validateSocialUrl(platform, url) {
  if (!url) return false;

  const patterns = {
    youtube: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i,
    twitter: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i,
    instagram: /^https?:\/\/(www\.)?instagram\.com\//i,
    twitch: /^https?:\/\/(www\.)?twitch\.tv\//i,
    tiktok: /^https?:\/\/(www\.)?tiktok\.com\//i,
    chzzk: /^https?:\/\/chzzk\.naver\.com\//i,
    afreecatv: /^https?:\/\/(www\.)?afreecatv\.com\//i,
  };

  const normalizedPlatform = platform?.toLowerCase();
  const pattern = patterns[normalizedPlatform];

  if (!pattern) {
    // For unknown platforms, just check if it's a valid URL
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  return pattern.test(url);
}

export default {
  buildSocialLinks,
  getActiveSocialLinks,
  hasSocialLinks,
  validateSocialUrl,
  PLATFORMS,
};
```

---

### 3.6 index.mjs (Re-export Module)

```javascript
/**
 * Supernoba Common Lambda Layer
 *
 * Central re-export module for all shared utilities.
 *
 * Usage:
 *   // Import specific modules
 *   import { getValkeyClient } from '/opt/nodejs/valkeyClient.mjs';
 *
 *   // Or import from index
 *   import { getValkeyClient, CORS, ok, buildSocialLinks } from '/opt/nodejs/index.mjs';
 */

// Re-export Valkey client
export {
  createValkeyClient,
  getValkeyClient,
  ensureConnected,
  closeAllClients,
  PRESETS as VALKEY_PRESETS,
  CACHE_HOSTS,
  RETRY_STRATEGIES,
} from './valkeyClient.mjs';

// Re-export DynamoDB client
export {
  getDynamoDBClient,
  ddb,
  TABLES,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from './ddbClient.mjs';

// Re-export CORS headers
export {
  CORS,
  withCors,
  preflightResponse,
  mergeHeaders,
} from './corsHeaders.mjs';

// Re-export response helpers
export {
  ok,
  created,
  error,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serverError,
  serviceUnavailable,
  parseBody,
} from './responseHelpers.mjs';

// Re-export social links
export {
  buildSocialLinks,
  getActiveSocialLinks,
  hasSocialLinks,
  validateSocialUrl,
  PLATFORMS,
} from './socialLinks.mjs';
```

---

## 4. Lambda Functions Requiring Updates

### 4.1 Full Update List (14 Redis + 21 CORS)

| Lambda Function | Redis Update | CORS Update | Priority |
|----------------|--------------|-------------|----------|
| Supernoba-connect-handler | Yes (websocket) | No | High |
| Supernoba-disconnect-handler | Yes (websocket) | No | High |
| Supernoba-subscribe-handler | Yes (websocket) | No | High |
| Supernoba-notifier | Yes (processor) | No | High |
| Supernoba-cleanup-handler | Yes (batch) | No | Medium |
| Supernoba-admin-mm | Yes (marketMaker) | Yes (STANDARD) | High |
| Supernoba-admin-users | Yes (admin) | Yes (FULL) | Medium |
| Supernoba-admin-stats | Yes (admin) | Yes (READONLY) | Medium |
| Supernoba-admin-ws-handler | Yes (admin+depth) | No | High |
| Supernoba-admin-core | Yes (admin) | Yes (FULL) | Medium |
| Supernoba-admin | Yes (admin) | Yes (FULL) | Medium |
| Supernoba-admin-monitoring | Yes (admin) | Yes (READONLY) | Low |
| Supernoba-symbol-admin | Yes (admin) | Yes (FULL) | Medium |
| Supernoba-approval-handler | Yes (admin) | Yes (STANDARD) | Medium |
| Supernoba-asset-handler | No | Yes (WITH_API_KEY) | Medium |
| Supernoba-order-router | No | Yes (STANDARD) | High |
| Supernoba-auth | No | Yes (STANDARD) | Medium |
| Supernoba-x-auth | No | Yes (STANDARD) | Medium |
| Supernoba-creator-requests | No | Yes (FULL) | Medium |
| Supernoba-favorites | No | Yes (FULL) | Low |
| ~~Supernoba-user-init~~ | DEPRECATED | Supernoba-auth로 통합 | - |
| Supernoba-chart-data-handler | No | Yes (READONLY) | Low |
| Supernoba-preview-handler | No | Yes (READONLY) | Low |
| Supernoba-ec2-mgmt | No | Yes (STANDARD) | Low |

---

## 5. Migration Guide

### 5.1 Redis/Valkey Migration

#### OLD Code (Supernoba-connect-handler):
```javascript
import Redis from 'ioredis';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  retryStrategy: () => null,
});

valkey.on('error', () => {});

// In handler...
if (valkey.status !== 'ready') {
  await valkey.connect();
}
```

#### NEW Code:
```javascript
import { getValkeyClient, ensureConnected } from '/opt/nodejs/valkeyClient.mjs';

const valkey = getValkeyClient('websocket');

// In handler...
await ensureConnected(valkey);
```

---

#### OLD Code (Supernoba-admin-mm - backup cache):
```javascript
import Redis from 'ioredis';

const VALKEY_HOST = process.env.VALKEY_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';

const valkey = new Redis({
  host: VALKEY_HOST,
  port: 6379,
  tls: {},
  connectTimeout: 5000,
  maxRetriesPerRequest: 3
});
valkey.on('error', (err) => console.error('Redis error:', err.message));
```

#### NEW Code:
```javascript
import { getValkeyClient } from '/opt/nodejs/valkeyClient.mjs';

const valkey = getValkeyClient('marketMaker');
```

---

### 5.2 CORS Headers Migration

#### OLD Code (Supernoba-admin-users):
```javascript
const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

const ok = (d) => ({ statusCode: 200, headers: H, body: JSON.stringify(d) });
const err = (c, m) => ({ statusCode: c, headers: H, body: JSON.stringify({ error: m }) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  // ...
  return ok({ users: [...] });
};
```

#### NEW Code:
```javascript
import { CORS, preflightResponse } from '/opt/nodejs/corsHeaders.mjs';
import { ok, error } from '/opt/nodejs/responseHelpers.mjs';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflightResponse(CORS.FULL);
  // ...
  return ok({ users: [...] }, CORS.FULL);
};
```

---

### 5.3 buildSocialLinks Migration

#### OLD Code (Supernoba-asset-handler):
```javascript
// 42 lines of duplicated code
function buildSocialLinks(platform, creatorUrl, existingSocialLinks) {
    const links = {
        youtube: existingSocialLinks?.youtube || null,
        twitter: existingSocialLinks?.twitter || null,
        // ... 7 platforms
    };

    if (creatorUrl) {
        switch (platform?.toUpperCase()) {
            case 'YOUTUBE':
                links.youtube = creatorUrl;
                break;
            // ... 7 cases
        }
    }

    return links;
}
```

#### NEW Code:
```javascript
import { buildSocialLinks } from '/opt/nodejs/socialLinks.mjs';

// Use directly - same API
const socialLinks = buildSocialLinks(item.platform, item.creatorUrl, item.socialLinks);
```

---

### 5.4 Combined Migration Example

#### OLD Code (Full Lambda):
```javascript
import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'hardcoded-host',
  port: 6379,
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});
valkey.on('error', () => {});

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  try {
    if (valkey.status !== 'ready') await valkey.connect();

    const { Item } = await ddb.send(new GetCommand({
      TableName: 'supernoba-users',
      Key: { user_id: event.queryStringParameters.userId }
    }));

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ user: Item })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message })
    };
  }
};
```

#### NEW Code (Full Lambda):
```javascript
import { getValkeyClient, ensureConnected } from '/opt/nodejs/valkeyClient.mjs';
import { ddb, TABLES } from '/opt/nodejs/ddbClient.mjs';
import { CORS, preflightResponse } from '/opt/nodejs/corsHeaders.mjs';
import { ok, serverError } from '/opt/nodejs/responseHelpers.mjs';

const valkey = getValkeyClient('processor');

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflightResponse();

  try {
    await ensureConnected(valkey);

    const { Item } = await ddb.get(TABLES.USER_CACHE, {
      user_id: event.queryStringParameters.userId
    });

    return ok({ user: Item });
  } catch (e) {
    return serverError(e.message);
  }
};
```

**Lines of code reduced: 45 -> 18 (60% reduction)**

---

## 6. Backward Compatibility Considerations

### 6.1 Graceful Fallback

Each Lambda should gracefully handle cases where the layer is not available:

```javascript
// Safe import pattern
let valkeyModule;
try {
  valkeyModule = await import('/opt/nodejs/valkeyClient.mjs');
} catch (e) {
  console.warn('[Lambda] Common layer not available, using fallback');
  // Fallback to direct ioredis import
  const Redis = (await import('ioredis')).default;
  valkeyModule = {
    getValkeyClient: () => new Redis({
      host: process.env.VALKEY_HOST,
      port: 6379,
      tls: process.env.VALKEY_TLS === 'true' ? {} : undefined,
    }),
    ensureConnected: async (client) => {
      if (client.status !== 'ready') await client.connect();
      return true;
    }
  };
}

const { getValkeyClient, ensureConnected } = valkeyModule;
```

### 6.2 Environment Variable Compatibility

The layer uses the same environment variables as existing code:
- `VALKEY_HOST` - Primary cache host
- `VALKEY_PORT` - Redis port
- `VALKEY_TLS` - TLS enable flag
- `AWS_REGION` - AWS region for DynamoDB

No environment variable changes required for migration.

### 6.3 Phased Rollout Strategy

1. **Phase 1: Deploy Layer** - Deploy layer to Lambda without modifying functions
2. **Phase 2: Test Functions** - Update 2-3 non-critical Lambdas (cleanup-handler, favorites)
3. **Phase 3: Core Functions** - Update WebSocket handlers (connect, disconnect, subscribe)
4. **Phase 4: Admin Functions** - Update admin Lambdas
5. **Phase 5: Remaining** - Update all remaining functions

---

## 7. Testing Strategy

### 7.1 Unit Tests

```javascript
// tests/valkeyClient.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createValkeyClient, PRESETS } from '../valkeyClient.mjs';

describe('ValkeyClient', () => {
  it('should create websocket client with correct config', () => {
    const client = createValkeyClient('websocket');
    expect(client.options.connectTimeout).toBe(3000);
    expect(client.options.maxRetriesPerRequest).toBe(1);
  });

  it('should create admin client with backup host', () => {
    const client = createValkeyClient('admin');
    expect(client.options.host).toContain('backup');
    expect(client.options.maxRetriesPerRequest).toBe(3);
  });

  it('should reuse singleton clients', () => {
    const { getValkeyClient } = require('../valkeyClient.mjs');
    const client1 = getValkeyClient('websocket');
    const client2 = getValkeyClient('websocket');
    expect(client1).toBe(client2);
  });
});

// tests/responseHelpers.test.mjs
describe('ResponseHelpers', () => {
  it('should create OK response with JSON body', () => {
    const { ok } = require('../responseHelpers.mjs');
    const response = ok({ data: 'test' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ data: 'test' });
  });

  it('should create error response with code', () => {
    const { badRequest } = require('../responseHelpers.mjs');
    const response = badRequest('Invalid input');
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('BAD_REQUEST');
  });
});

// tests/socialLinks.test.mjs
describe('SocialLinks', () => {
  it('should map YouTube platform to youtube key', () => {
    const { buildSocialLinks } = require('../socialLinks.mjs');
    const links = buildSocialLinks('YOUTUBE', 'https://youtube.com/@test');
    expect(links.youtube).toBe('https://youtube.com/@test');
    expect(links.twitter).toBeNull();
  });

  it('should handle X as Twitter', () => {
    const { buildSocialLinks } = require('../socialLinks.mjs');
    const links = buildSocialLinks('X', 'https://x.com/test');
    expect(links.twitter).toBe('https://x.com/test');
  });

  it('should preserve existing links', () => {
    const { buildSocialLinks } = require('../socialLinks.mjs');
    const existing = { instagram: 'https://instagram.com/test' };
    const links = buildSocialLinks('YOUTUBE', 'https://youtube.com/@test', existing);
    expect(links.youtube).toBe('https://youtube.com/@test');
    expect(links.instagram).toBe('https://instagram.com/test');
  });
});
```

### 7.2 Integration Tests

```javascript
// tests/integration/layer.test.mjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Layer Integration', () => {
  let valkey;

  beforeAll(async () => {
    const { getValkeyClient, ensureConnected } = await import('/opt/nodejs/valkeyClient.mjs');
    valkey = getValkeyClient('processor');
    await ensureConnected(valkey);
  });

  afterAll(async () => {
    const { closeAllClients } = await import('/opt/nodejs/valkeyClient.mjs');
    await closeAllClients();
  });

  it('should connect to Redis and perform operations', async () => {
    await valkey.set('test:key', 'test-value');
    const value = await valkey.get('test:key');
    expect(value).toBe('test-value');
    await valkey.del('test:key');
  });

  it('should work with DynamoDB client', async () => {
    const { ddb, TABLES } = await import('/opt/nodejs/ddbClient.mjs');
    // Scan with limit to verify connection
    const result = await ddb.scan(TABLES.SYMBOLS, { Limit: 1 });
    expect(result).toHaveProperty('Items');
  });
});
```

### 7.3 E2E Tests (Lambda Invocation)

```javascript
// tests/e2e/lambda.test.mjs
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

describe('Lambda E2E', () => {
  const lambda = new LambdaClient({ region: 'ap-northeast-2' });

  it('should handle OPTIONS preflight', async () => {
    const response = await lambda.send(new InvokeCommand({
      FunctionName: 'Supernoba-admin-users',
      Payload: JSON.stringify({
        httpMethod: 'OPTIONS',
        headers: {},
      }),
    }));

    const result = JSON.parse(Buffer.from(response.Payload).toString());
    expect(result.statusCode).toBe(200);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
```

### 7.4 Performance Benchmarks

```javascript
// tests/benchmark/valkey.bench.mjs
import { bench, describe } from 'vitest';
import Redis from 'ioredis';
import { getValkeyClient } from '../valkeyClient.mjs';

describe('Redis Connection Benchmark', () => {
  bench('Direct ioredis', async () => {
    const client = new Redis({ host: process.env.VALKEY_HOST, lazyConnect: true });
    await client.connect();
    await client.ping();
    await client.quit();
  });

  bench('Layer singleton', async () => {
    const client = getValkeyClient('websocket');
    await client.ping();
  });
});
```

---

## 8. Deployment Checklist

### 8.1 Pre-Deployment

- [ ] Run all unit tests
- [ ] Run integration tests against staging Redis
- [ ] Verify layer package size (< 50MB unzipped)
- [ ] Check all environment variables are documented
- [ ] Review IAM permissions for layer access

### 8.2 Deployment Steps

1. **Build Layer Package**
   ```bash
   cd lambda/layers/supernoba-common
   npm install --production
   zip -r supernoba-common-layer.zip nodejs/
   ```

2. **Publish Layer**
   ```bash
   aws lambda publish-layer-version \
     --layer-name supernoba-common \
     --zip-file fileb://supernoba-common-layer.zip \
     --compatible-runtimes nodejs20.x \
     --region ap-northeast-2
   ```

3. **Update Lambda Functions**
   ```bash
   aws lambda update-function-configuration \
     --function-name Supernoba-connect-handler \
     --layers arn:aws:lambda:ap-northeast-2:ACCOUNT:layer:supernoba-common:1
   ```

### 8.3 Post-Deployment Validation

- [ ] Verify WebSocket connections work (connect-handler)
- [ ] Test admin dashboard data loading
- [ ] Check market maker functionality
- [ ] Monitor CloudWatch logs for errors
- [ ] Verify CORS headers in browser network tab

---

## 9. Estimated Impact

### 9.1 Code Reduction

| Area | Before | After | Reduction |
|------|--------|-------|-----------|
| Redis config lines | ~350 (14 files x 25 lines) | ~28 (14 files x 2 lines) | 92% |
| CORS header definitions | ~126 (21 files x 6 lines) | ~21 (21 files x 1 line) | 83% |
| buildSocialLinks | 84 lines (2 files x 42) | 1 import | 99% |
| **Total** | **~560 lines** | **~50 lines** | **91%** |

### 9.2 Maintenance Benefits

- **Single source of truth** for Redis configurations
- **Consistent behavior** across all Lambda functions
- **Easier testing** with standardized patterns
- **Faster onboarding** for new developers
- **Reduced bug surface** for connection/header issues

### 9.3 Performance Considerations

- **Cold start impact**: Minimal (+10-20ms) due to module loading
- **Warm invocation**: Improved due to singleton caching
- **Memory**: Reduced per-function memory from shared code

---

## 10. Future Enhancements

1. **Secrets Management Module** - Centralize AWS Secrets Manager access
2. **Logging Module** - Structured JSON logging with correlation IDs
3. **Metrics Module** - CloudWatch custom metrics helpers
4. **Circuit Breaker** - Resilience pattern for external service calls
5. **Rate Limiting** - API rate limit enforcement utilities

---

*Document Version: 1.0*
*Created: 2026-01-06*
*Author: Architecture Team*
