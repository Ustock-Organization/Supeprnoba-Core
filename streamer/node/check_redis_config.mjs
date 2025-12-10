
import Redis from 'ioredis';

const BACKUP_HOST = 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';
const BACKUP_PORT = 6379;

const DEPTH_HOST = 'master.supernoba-depth-cache.5vrxzz.apn2.cache.amazonaws.com';
const DEPTH_PORT = 6379;

async function checkConnection(name, host, port, useTls) {
  console.log(`Checking ${name} (${host}:${port}) with TLS=${useTls}...`);
  const redis = new Redis({
    host: host,
    port: port,
    tls: useTls ? {} : undefined,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: null
  });

  try {
    await redis.ping();
    console.log(`✅ [SUCCESS] ${name} connected with TLS=${useTls}`);
    return true;
  } catch (err) {
    console.log(`❌ [FAILED] ${name} failed with TLS=${useTls}: ${err.message}`);
    return false;
  } finally {
    redis.disconnect();
  }
}

async function run() {
  console.log('=== Verifying Redis Configuration ===');
  
  // 1. Check Backup Cache (Expect Non-TLS)
  await checkConnection('Backup Cache (Non-TLS Expectation)', BACKUP_HOST, BACKUP_PORT, false);
  
  // 2. Check Depth Cache (Expect TLS)
  await checkConnection('Depth Cache (TLS Expectation)', DEPTH_HOST, DEPTH_PORT, true);
  
  console.log('-------------------------------------');
  console.log('Checking alternative configurations to be sure...');
  
  // Side Check: Backup with TLS (Should fail)
  await checkConnection('Backup Cache (TLS Check)', BACKUP_HOST, BACKUP_PORT, true);
  
  // Side Check: Depth with Non-TLS (Should fail)
  await checkConnection('Depth Cache (Non-TLS Check)', DEPTH_HOST, DEPTH_PORT, false);
}

run();
