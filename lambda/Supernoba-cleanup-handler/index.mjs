import Redis from 'ioredis';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
// 2분 기본값 (하트비트 30초 * 4 = 4번 연속 실패 시 stale)
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MS || '120000');
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');

// Valkey client configuration
const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 200, 1000);
  },
});

valkey.on('error', (err) => {
  console.error('[cleanup] Redis connection error:', err.message);
});

/**
 * Scan for all ws:* keys in Valkey
 */
async function scanWsKeys() {
  const keys = [];
  let cursor = '0';

  do {
    const [nextCursor, foundKeys] = await valkey.scan(cursor, 'MATCH', 'ws:*', 'COUNT', BATCH_SIZE);
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');

  return keys;
}

/**
 * Check if a connection is stale based on lastSeen timestamp
 * lastSeen은 하트비트(ping)마다 갱신됨
 * lastSeen이 없으면 connectedAt을 fallback으로 사용
 */
function isStale(connectionInfo, now) {
  try {
    const parsed = typeof connectionInfo === 'string' ? JSON.parse(connectionInfo) : connectionInfo;
    // lastSeen 우선, 없으면 connectedAt (하위 호환)
    const lastActivity = parsed.lastSeen || parsed.connectedAt || 0;
    const idleTime = now - lastActivity;
    return idleTime > STALE_THRESHOLD_MS;
  } catch {
    // If we can't parse, consider it stale
    return true;
  }
}

/**
 * Clean up stale connections
 */
async function cleanupStaleConnections() {
  const now = Date.now();
  const stats = {
    scanned: 0,
    stale: 0,
    cleaned: 0,
    errors: 0,
  };

  console.log(`[cleanup] Starting cleanup scan at ${new Date(now).toISOString()}`);
  console.log(`[cleanup] Stale threshold: ${STALE_THRESHOLD_MS}ms (${STALE_THRESHOLD_MS / 1000 / 60} minutes)`);

  // Scan for ws:* keys
  const wsKeys = await scanWsKeys();
  stats.scanned = wsKeys.length;
  console.log(`[cleanup] Found ${wsKeys.length} ws:* keys`);

  if (wsKeys.length === 0) {
    return stats;
  }

  // Check each connection for staleness
  const staleKeys = [];
  const staleConnectionIds = [];

  for (const key of wsKeys) {
    try {
      const connectionInfo = await valkey.get(key);
      if (!connectionInfo) {
        // Key exists but no value - clean it up
        staleKeys.push(key);
        staleConnectionIds.push(key.replace('ws:', ''));
        stats.stale++;
        continue;
      }

      if (isStale(connectionInfo, now)) {
        staleKeys.push(key);
        staleConnectionIds.push(key.replace('ws:', ''));
        stats.stale++;

        // Also get userId to clean up user:*:connections
        try {
          const parsed = JSON.parse(connectionInfo);
          if (parsed.userId) {
            await valkey.srem(`user:${parsed.userId}:connections`, key.replace('ws:', ''));
          }
        } catch {
          // Ignore parse errors for cleanup
        }
      }
    } catch (err) {
      console.error(`[cleanup] Error checking key ${key}:`, err.message);
      stats.errors++;
    }
  }

  console.log(`[cleanup] Found ${stats.stale} stale connections`);

  // Delete stale keys in batches
  if (staleKeys.length > 0) {
    const pipeline = valkey.pipeline();

    for (const key of staleKeys) {
      pipeline.del(key);
    }

    // realtime:connections 제거됨 - 브로드캐스트에서 미사용

    try {
      await pipeline.exec();
      stats.cleaned = staleKeys.length;
      console.log(`[cleanup] Deleted ${stats.cleaned} stale keys`);
    } catch (err) {
      console.error(`[cleanup] Error deleting keys:`, err.message);
      stats.errors++;
    }
  }

  // realtime:connections 정리 제거됨 - 키 자체가 더 이상 사용되지 않음

  // Clean up orphaned connectionIds from symbol:*:main, symbol:*:sub, and symbol:*:subscribers sets
  try {
    const subscribedSymbols = await valkey.smembers('subscribed:symbols');
    let orphanedSymbolConnections = 0;

    for (const symbol of subscribedSymbols) {
      // Clean orphaned connectionIds from symbol:*:main
      const mainMembers = await valkey.smembers(`symbol:${symbol}:main`);
      for (const connId of mainMembers) {
        const exists = await valkey.exists(`ws:${connId}`);
        if (!exists) {
          await valkey.srem(`symbol:${symbol}:main`, connId);
          orphanedSymbolConnections++;
          console.log(`[cleanup] Removed orphaned connId ${connId} from symbol:${symbol}:main`);
        }
      }

      // Clean orphaned connectionIds from symbol:*:sub
      const subMembers = await valkey.smembers(`symbol:${symbol}:sub`);
      for (const connId of subMembers) {
        const exists = await valkey.exists(`ws:${connId}`);
        if (!exists) {
          await valkey.srem(`symbol:${symbol}:sub`, connId);
          orphanedSymbolConnections++;
          console.log(`[cleanup] Removed orphaned connId ${connId} from symbol:${symbol}:sub`);
        }
      }

      // Clean orphaned connectionIds from symbol:*:subscribers
      const subscriberMembers = await valkey.smembers(`symbol:${symbol}:subscribers`);
      for (const connId of subscriberMembers) {
        const exists = await valkey.exists(`ws:${connId}`);
        if (!exists) {
          await valkey.srem(`symbol:${symbol}:subscribers`, connId);
          orphanedSymbolConnections++;
          console.log(`[cleanup] Removed orphaned connId ${connId} from symbol:${symbol}:subscribers`);
        }
      }

      // After cleanup, check if symbol should be removed from subscribed:symbols
      const mainSubs = await valkey.scard(`symbol:${symbol}:main`);
      const subSubs = await valkey.scard(`symbol:${symbol}:sub`);
      const subscribers = await valkey.scard(`symbol:${symbol}:subscribers`);

      if (mainSubs === 0 && subSubs === 0 && subscribers === 0) {
        await valkey.srem('subscribed:symbols', symbol);
        console.log(`[cleanup] Removed orphaned subscribed:symbols entry: ${symbol}`);
      }
    }

    if (orphanedSymbolConnections > 0) {
      console.log(`[cleanup] Removed ${orphanedSymbolConnections} orphaned connectionIds from symbol sets`);
    }
  } catch (err) {
    console.error(`[cleanup] Error cleaning symbol subscription sets:`, err.message);
    stats.errors++;
  }

  // Clean up orphaned conn:*:main keys (connection tracking without valid ws:* key)
  try {
    let connMainCursor = '0';
    let orphanedConnMain = 0;
    const connMainKeysToDelete = [];

    do {
      const [nextCursor, foundKeys] = await valkey.scan(connMainCursor, 'MATCH', 'conn:*:main', 'COUNT', BATCH_SIZE);
      connMainCursor = nextCursor;

      for (const key of foundKeys) {
        // Extract connectionId from conn:CONNID:main pattern
        const match = key.match(/^conn:(.+):main$/);
        if (match) {
          const connId = match[1];
          const wsExists = await valkey.exists(`ws:${connId}`);
          if (!wsExists) {
            connMainKeysToDelete.push(key);
            orphanedConnMain++;
          }
        }
      }
    } while (connMainCursor !== '0');

    // Delete orphaned conn:*:main keys in a batch
    if (connMainKeysToDelete.length > 0) {
      const pipeline = valkey.pipeline();
      for (const key of connMainKeysToDelete) {
        pipeline.del(key);
        console.log(`[cleanup] Deleting orphaned key: ${key}`);
      }
      await pipeline.exec();
      console.log(`[cleanup] Removed ${orphanedConnMain} orphaned conn:*:main keys`);
    }
  } catch (err) {
    console.error(`[cleanup] Error cleaning conn:*:main keys:`, err.message);
    stats.errors++;
  }

  return stats;
}

/**
 * Lambda handler
 */
export const handler = async (event) => {
  console.log('[cleanup] Handler invoked:', JSON.stringify(event));

  const startTime = Date.now();

  try {
    // Ensure connection is established
    if (valkey.status !== 'ready') {
      await valkey.connect();
    }

    const stats = await cleanupStaleConnections();

    const duration = Date.now() - startTime;
    console.log(`[cleanup] Completed in ${duration}ms:`, JSON.stringify(stats));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Cleanup completed',
        duration: duration,
        stats: stats,
      }),
    };
  } catch (err) {
    console.error('[cleanup] Handler error:', err.message, err.stack);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message,
        duration: Date.now() - startTime,
      }),
    };
  }
};
