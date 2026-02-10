-- Supernoba Aggregator - PostgreSQL Schema Setup
-- Run: psql -h localhost -U supernoba -d supernoba -f setup-postgres.sql

-- candle_history 테이블 (파티션 부모)
CREATE TABLE IF NOT EXISTS candle_history (
    symbol VARCHAR(20) NOT NULL,
    interval VARCHAR(10) NOT NULL,
    time_epoch BIGINT NOT NULL,
    time_ymdhm VARCHAR(20) NOT NULL,
    open DOUBLE PRECISION NOT NULL,
    high DOUBLE PRECISION NOT NULL,
    low DOUBLE PRECISION NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    volume DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (symbol, interval, time_epoch)
) PARTITION BY LIST (symbol);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_candle_history_time 
    ON candle_history (symbol, interval, time_epoch DESC);

-- symbol_prev_close 테이블 (전일종가 관리)
CREATE TABLE IF NOT EXISTS symbol_prev_close (
    symbol VARCHAR(20) PRIMARY KEY,
    prev_close DOUBLE PRECISION NOT NULL,
    prev_trading_date DATE NOT NULL,
    last_close DOUBLE PRECISION,
    last_trading_date DATE,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 기본 파티션 (알 수 없는 심볼용 fallback)
CREATE TABLE IF NOT EXISTS candle_history_default 
    PARTITION OF candle_history DEFAULT;

-- 몇 개 테스트 심볼 파티션 생성
DO $$
DECLARE
    symbols TEXT[] := ARRAY['btcusdt', 'ethusdt', 'test'];
    sym TEXT;
BEGIN
    FOREACH sym IN ARRAY symbols
    LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS candle_history_%I PARTITION OF candle_history FOR VALUES IN (%L)',
            sym, sym
        );
    END LOOP;
END $$;

-- 확인
SELECT 'Tables created successfully' AS status;
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
