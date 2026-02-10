/**
 * PriceFeed - External price feed from Binance WebSocket
 *
 * Connects to Binance 24hr ticker stream for market sentiment reference.
 * Supernoba is an influencer quasi-securities platform, so we don't sync
 * absolute prices — only use priceChangePercent as a "market mood" indicator.
 *
 * Usage:
 *   const feed = new PriceFeed('btcusdt');
 *   await feed.connect();
 *   const pct = feed.getPriceChangePercent(); // e.g. 2.5 for +2.5%
 *   const adjusted = feed.applyExternalInfluence(basePrice, 0.3);
 *   feed.disconnect();
 */

import WebSocket from 'ws';

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY = 5000; // 5s
const HEARTBEAT_TIMEOUT = 30000; // 30s — reconnect if no message

export default class PriceFeed {
  /**
   * @param {string} externalSymbol - Binance symbol, e.g. "btcusdt"
   */
  constructor(externalSymbol = 'btcusdt') {
    this.symbol = externalSymbol.toLowerCase();
    this.url = `${BINANCE_WS_BASE}/${this.symbol}@ticker`;

    this.ws = null;
    this.ticker = null;
    this.priceChangePercent = null;
    this.connected = false;

    this.retryCount = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.intentionalClose = false;
  }

  /**
   * Connect to Binance ticker stream.
   * Resolves once the first message is received, or after 10s timeout.
   */
  async connect() {
    this.intentionalClose = false;
    return new Promise((resolve) => {
      let resolved = false;
      const onFirstMessage = () => {
        if (!resolved) { resolved = true; resolve(); }
      };
      // Resolve after 10s even if no message yet (non-blocking)
      setTimeout(onFirstMessage, 10000);

      this._connect(onFirstMessage);
    });
  }

  /**
   * @private
   */
  _connect(onFirstMessage) {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`[PriceFeed] WebSocket constructor error: ${err.message}`);
      this._scheduleReconnect(onFirstMessage);
      return;
    }

    this.ws.on('open', () => {
      console.log(`[PriceFeed] Connected to ${this.symbol}@ticker`);
      this.connected = true;
      this._resetHeartbeat();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.ticker = msg;
        // P = priceChangePercent (string, e.g. "2.500")
        if (msg.P !== undefined) {
          this.priceChangePercent = parseFloat(msg.P);
        }
        // Successful message resets retry counter
        this.retryCount = 0;
        this._resetHeartbeat();

        if (onFirstMessage) {
          onFirstMessage();
          onFirstMessage = null; // only call once
        }
      } catch (err) {
        console.error(`[PriceFeed] Parse error: ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this._clearHeartbeat();
      if (!this.intentionalClose) {
        console.warn(`[PriceFeed] Closed (code=${code}). Scheduling reconnect...`);
        this._scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[PriceFeed] WebSocket error: ${err.message}`);
      // 'close' event will fire after this — reconnect handled there
    });
  }

  /**
   * @private - Exponential backoff: 5s, 10s, 20s, 40s, 80s
   */
  _scheduleReconnect(onFirstMessage) {
    if (this.intentionalClose) return;
    if (this.retryCount >= MAX_RETRIES) {
      console.error(`[PriceFeed] Max retries (${MAX_RETRIES}) reached. Giving up.`);
      return;
    }

    const delay = BASE_RETRY_DELAY * Math.pow(2, this.retryCount);
    this.retryCount++;
    console.log(`[PriceFeed] Reconnecting in ${delay / 1000}s (attempt ${this.retryCount}/${MAX_RETRIES})...`);

    this.reconnectTimer = setTimeout(() => {
      this._connect(onFirstMessage || null);
    }, delay);
  }

  /**
   * @private - If no message for 30s, assume stale and reconnect
   */
  _resetHeartbeat() {
    this._clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      console.warn(`[PriceFeed] No message for ${HEARTBEAT_TIMEOUT / 1000}s. Reconnecting...`);
      this._forceReconnect();
    }, HEARTBEAT_TIMEOUT);
  }

  /** @private */
  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** @private */
  _forceReconnect() {
    this._clearHeartbeat();
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
    this._scheduleReconnect();
  }

  /**
   * Get current price change percentage from Binance 24hr ticker.
   * @returns {number|null} e.g. 2.5 for +2.5%, or null if disconnected/no data
   */
  getPriceChangePercent() {
    return this.priceChangePercent;
  }

  /**
   * Get the raw Binance 24hr ticker data.
   * @returns {object|null}
   */
  getTicker() {
    return this.ticker;
  }

  /**
   * Apply external market influence to a base price.
   *
   * adjustedPrice = basePrice * (1 + priceChangePercent/100 * correlation)
   * Clamped to [basePrice * 0.8, basePrice * 1.2] (max 20% influence).
   *
   * @param {number} basePrice - Internal MM base price
   * @param {number} correlation - 0~1, how much to follow external market (default 0.3)
   * @returns {number} adjusted price
   */
  applyExternalInfluence(basePrice, correlation = 0.3) {
    if (!this.connected || this.priceChangePercent === null) {
      return basePrice;
    }

    const factor = 1 + (this.priceChangePercent / 100) * correlation;
    const adjusted = basePrice * factor;

    // Clamp to max 20% influence
    const floor = basePrice * 0.8;
    const ceil = basePrice * 1.2;
    return Math.max(floor, Math.min(ceil, adjusted));
  }

  /**
   * Gracefully disconnect.
   */
  disconnect() {
    this.intentionalClose = true;
    this._clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'intentional'); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
    console.log(`[PriceFeed] Disconnected from ${this.symbol}@ticker`);
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}
