-- ============================================================================
-- Supernoba RDS 스키마 - 테이블 정의
-- 실행: ./run-sql.sh schema/001_create_tables.sql
-- ============================================================================

-- 1. 일일 OHLC 요약 테이블 (심볼별 일일 집계)
CREATE TABLE IF NOT EXISTS public.daily_ohlc_summary (
    id SERIAL,
    symbol TEXT NOT NULL,
    trading_date DATE NOT NULL,
    open_price NUMERIC(18, 8) NOT NULL,
    high_price NUMERIC(18, 8) NOT NULL,
    low_price NUMERIC(18, 8) NOT NULL,
    close_price NUMERIC(18, 8) NOT NULL,
    prev_close NUMERIC(18, 8),
    volume NUMERIC(24, 8) DEFAULT 0,
    trade_count INTEGER DEFAULT 0,
    turnover NUMERIC(24, 8) DEFAULT 0,
    change_amount NUMERIC(18, 8) DEFAULT 0,
    change_percent NUMERIC(10, 4) DEFAULT 0,
    vwap NUMERIC(18, 8),
    is_finalized BOOLEAN DEFAULT FALSE,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (symbol, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_ohlc_trading_date
    ON daily_ohlc_summary(trading_date);

CREATE INDEX IF NOT EXISTS idx_daily_ohlc_not_finalized
    ON daily_ohlc_summary(is_finalized) WHERE is_finalized = FALSE;

-- 2. 심볼별 전일종가 관리 테이블
CREATE TABLE IF NOT EXISTS public.symbol_prev_close (
    symbol TEXT PRIMARY KEY,
    prev_close NUMERIC(18, 8) NOT NULL,
    prev_trading_date DATE NOT NULL,
    last_close NUMERIC(18, 8),
    last_trading_date DATE,
    listing_price NUMERIC(18, 8),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. 일일 마감 작업 로그 테이블
CREATE TABLE IF NOT EXISTS public.daily_close_job_log (
    id SERIAL PRIMARY KEY,
    job_name TEXT NOT NULL,
    trading_date DATE NOT NULL,
    status TEXT NOT NULL,
    symbols_processed INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_daily_close_job_log_date
    ON daily_close_job_log(trading_date, job_name);

-- 4. 활성 심볼 목록 테이블
CREATE TABLE IF NOT EXISTS public.active_symbols (
    symbol TEXT PRIMARY KEY,
    listing_price NUMERIC(18, 8),
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. 캔들 히스토리 테이블
CREATE TABLE IF NOT EXISTS public.candle_history (
    id SERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    time BIGINT NOT NULL,
    open NUMERIC(18, 8) NOT NULL,
    high NUMERIC(18, 8) NOT NULL,
    low NUMERIC(18, 8) NOT NULL,
    close NUMERIC(18, 8) NOT NULL,
    volume NUMERIC(24, 8) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(symbol, interval, time)
);

CREATE INDEX IF NOT EXISTS idx_candle_history_symbol_interval
    ON candle_history(symbol, interval, time DESC);

-- 6. 거래 히스토리 테이블
CREATE TABLE IF NOT EXISTS public.trade_history (
    id SERIAL PRIMARY KEY,
    trade_id TEXT UNIQUE,
    symbol TEXT NOT NULL,
    price NUMERIC(18, 8) NOT NULL,
    quantity NUMERIC(24, 8) NOT NULL,
    buyer_order_id TEXT,
    seller_order_id TEXT,
    buyer_id TEXT,
    seller_id TEXT,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_history_symbol
    ON trade_history(symbol, timestamp DESC);

-- 7. Market Maker 설정 테이블
CREATE TABLE IF NOT EXISTS public.market_maker_configs (
    symbol TEXT PRIMARY KEY,
    base_price NUMERIC(18, 8),
    period INTEGER DEFAULT 600,
    amplitude NUMERIC(10, 4) DEFAULT 0.1,
    tick_interval INTEGER DEFAULT 1000,
    trade_quantity INTEGER DEFAULT 10,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 테이블 코멘트
COMMENT ON TABLE daily_ohlc_summary IS '일일 OHLC 요약';
COMMENT ON TABLE symbol_prev_close IS '심볼별 전일종가 관리';
COMMENT ON TABLE daily_close_job_log IS '일일 마감 작업 로그';
COMMENT ON TABLE active_symbols IS '활성 심볼 목록';
COMMENT ON TABLE candle_history IS '캔들 히스토리';
COMMENT ON TABLE trade_history IS '거래 히스토리';
COMMENT ON TABLE market_maker_configs IS 'Market Maker 설정';
