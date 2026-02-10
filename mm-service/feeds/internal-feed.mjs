/**
 * InternalFeed - Internal price feed from Valkey caches
 *
 * Reads live prices from Depth Cache (6379) and Candle Cache (6380).
 * Used by MM strategies to know the current market state before placing orders.
 *
 * Keys read:
 *   - ohlc:{SYMBOL}  (Depth Cache 6379) — JSON {o, h, l, c, v, change, t}
 *   - depth:{SYMBOL}  (Depth Cache 6379) — JSON {b: [[price, qty]...], a: [[price, qty]...]}
 *
 * Usage:
 *   const feed = new InternalFeed({ host: '127.0.0.1' });
 *   await feed.connect();
 *   const price = await feed.getBestPrice('APPLE');
 *   await feed.disconnect();
 */

import Redis from 'ioredis';

export default class InternalFeed {
  /**
   * @param {object} options
   * @param {string} [options.host] - Cache host (default: env or localhost)
   * @param {number} [options.depthPort] - Depth cache port (default: 6379)
   * @param {number} [options.candlePort] - Candle cache port (default: 6380)
   */
  constructor(options = {}) {
    const host = options.host
      || process.env.DEPTH_CACHE_HOST
      || process.env.OPERATING_CACHE_HOST
      || '127.0.0.1';

    const depthPort = options.depthPort || parseInt(process.env.DEPTH_CACHE_PORT || '6379');
    const candlePort = options.candlePort || parseInt(process.env.CANDLE_CACHE_PORT || '6380');

    // TLS: ElastiCache requires TLS, localhost (EC2) does not
    const useTls = process.env.VALKEY_TLS === 'true'
      && host !== '127.0.0.1'
      && host !== 'localhost';

    const commonOpts = {
      host,
      ...(useTls ? { tls: {} } : {}),
      connectTimeout: 5000,
      lazyConnect: true,
    };

    this.depthClient = new Redis({ ...commonOpts, port: depthPort });
    this.candleClient = new Redis({ ...commonOpts, port: candlePort });

    this.host = host;
    this.depthPort = depthPort;
    this.candlePort = candlePort;
  }

  /**
   * Connect to both Depth and Candle caches.
   */
  async connect() {
    try {
      await Promise.all([
        this.depthClient.connect(),
        this.candleClient.connect(),
      ]);
      console.log(`[InternalFeed] Connected — depth=${this.host}:${this.depthPort}, candle=${this.host}:${this.candlePort}`);
    } catch (err) {
      console.error(`[InternalFeed] Connection error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get last trade price from ohlc:{SYMBOL} (close field).
   * The ohlc key lives in Depth Cache (6379).
   *
   * @param {string} symbol - e.g. "APPLE"
   * @returns {number|null}
   */
  async getLastPrice(symbol) {
    try {
      const raw = await this.depthClient.get(`ohlc:${symbol}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const close = parseFloat(data.c);
      return isNaN(close) ? null : close;
    } catch (err) {
      console.error(`[InternalFeed] getLastPrice(${symbol}) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Get mid-price from depth:{SYMBOL}.
   * mid = (best_bid + best_ask) / 2
   *
   * depth key format: JSON {b: [[price, qty], ...], a: [[price, qty], ...]}
   *
   * @param {string} symbol - e.g. "APPLE"
   * @returns {number|null}
   */
  async getDepthMidPrice(symbol) {
    try {
      const raw = await this.depthClient.get(`depth:${symbol}`);
      if (!raw) return null;
      const data = JSON.parse(raw);

      const bids = data.b;
      const asks = data.a;
      if (!bids || !bids.length || !asks || !asks.length) return null;

      const bestBid = parseFloat(bids[0][0]);
      const bestAsk = parseFloat(asks[0][0]);
      if (isNaN(bestBid) || isNaN(bestAsk)) return null;

      return (bestBid + bestAsk) / 2;
    } catch (err) {
      console.error(`[InternalFeed] getDepthMidPrice(${symbol}) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Get best available price — tries mid-price first, then last close, then null.
   *
   * @param {string} symbol
   * @returns {number|null}
   */
  async getBestPrice(symbol) {
    const mid = await this.getDepthMidPrice(symbol);
    if (mid !== null) return mid;

    const last = await this.getLastPrice(symbol);
    if (last !== null) return last;

    return null;
  }

  /**
   * Disconnect both Redis clients.
   */
  async disconnect() {
    try {
      await Promise.all([
        this.depthClient.quit().catch(() => {}),
        this.candleClient.quit().catch(() => {}),
      ]);
      console.log('[InternalFeed] Disconnected');
    } catch (_) {}
  }
}
