-- ============================================================================
-- RDS 기반 일일 마감 로직 - 설치 스크립트
-- Finance Tracker 페르소나 설계
--
-- 설치 순서:
-- 1. 000_daily_close_install.sql (이 파일) - 전체 설치
-- 또는 개별 파일 순차 실행:
-- 1. 001_daily_close_tables.sql - 테이블 생성
-- 2. 002_daily_close_functions.sql - 함수 생성
-- 3. 003_pg_cron_jobs.sql - 스케줄 등록
-- 4. 004_valkey_sync_functions.sql - Valkey 동기화 함수
-- ============================================================================

-- ============================================================================
-- 사전 요구사항 확인
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'RDS Daily Close Logic Installation';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Prerequisites:';
    RAISE NOTICE '1. Aurora PostgreSQL 13.6+ or RDS PostgreSQL 12.5+';
    RAISE NOTICE '2. pg_cron extension enabled in parameter group';
    RAISE NOTICE '3. Database timezone: UTC (cron uses UTC)';
    RAISE NOTICE '========================================';
END
$$;

-- ============================================================================
-- 1. 확장 활성화
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================================
-- 2. 테이블 생성 (001_daily_close_tables.sql 내용)
-- ============================================================================

-- 일일 OHLC 요약 테이블
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

-- 심볼별 prevClose 관리 테이블
CREATE TABLE IF NOT EXISTS public.symbol_prev_close (
    symbol TEXT PRIMARY KEY,
    prev_close NUMERIC(18, 8) NOT NULL,
    prev_trading_date DATE NOT NULL,
    last_close NUMERIC(18, 8),
    last_trading_date DATE,
    listing_price NUMERIC(18, 8),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 일일 마감 작업 로그 테이블
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

-- 활성 심볼 목록 테이블
CREATE TABLE IF NOT EXISTS public.active_symbols (
    symbol TEXT PRIMARY KEY,
    listing_price NUMERIC(18, 8),
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

RAISE NOTICE 'Tables created successfully';

-- ============================================================================
-- 3. 함수 생성 (002_daily_close_functions.sql의 주요 함수들)
-- ============================================================================

-- 일일 OHLC 집계 함수
CREATE OR REPLACE FUNCTION fn_aggregate_daily_ohlc(
    p_trading_date DATE,
    p_symbol TEXT DEFAULT NULL
)
RETURNS TABLE (
    symbol TEXT,
    trading_date DATE,
    open_price NUMERIC,
    high_price NUMERIC,
    low_price NUMERIC,
    close_price NUMERIC,
    volume NUMERIC,
    trade_count INTEGER,
    turnover NUMERIC,
    vwap NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH daily_trades AS (
        SELECT
            th.symbol,
            th.price,
            th.quantity,
            th.created_at,
            DATE(th.created_at AT TIME ZONE 'Asia/Seoul') as trade_date
        FROM trade_history th
        WHERE DATE(th.created_at AT TIME ZONE 'Asia/Seoul') = p_trading_date
          AND (p_symbol IS NULL OR th.symbol = LOWER(p_symbol))
    ),
    first_last_trades AS (
        SELECT
            dt.symbol,
            FIRST_VALUE(dt.price) OVER (
                PARTITION BY dt.symbol
                ORDER BY dt.created_at ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as open_price,
            LAST_VALUE(dt.price) OVER (
                PARTITION BY dt.symbol
                ORDER BY dt.created_at ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as close_price,
            dt.price,
            dt.quantity
        FROM daily_trades dt
    )
    SELECT
        UPPER(flt.symbol)::TEXT as symbol,
        p_trading_date as trading_date,
        MAX(flt.open_price) as open_price,
        MAX(flt.price) as high_price,
        MIN(flt.price) as low_price,
        MAX(flt.close_price) as close_price,
        SUM(flt.quantity) as volume,
        COUNT(*)::INTEGER as trade_count,
        SUM(flt.price * flt.quantity) as turnover,
        CASE
            WHEN SUM(flt.quantity) > 0
            THEN SUM(flt.price * flt.quantity) / SUM(flt.quantity)
            ELSE NULL
        END as vwap
    FROM first_last_trades flt
    GROUP BY flt.symbol;
END;
$$;

-- 일일 마감 확정 함수 (간략화 버전, 전체 버전은 002 파일 참조)
CREATE OR REPLACE FUNCTION fn_finalize_daily_close(
    p_trading_date DATE DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
    v_processed INTEGER := 0;
    v_job_id INTEGER;
    v_start_time TIMESTAMPTZ;
BEGIN
    v_start_time := clock_timestamp();
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    INSERT INTO daily_close_job_log (job_name, trading_date, status)
    VALUES ('finalize_daily_close', v_target_date, 'started')
    RETURNING id INTO v_job_id;

    -- OHLC 집계 및 저장
    INSERT INTO daily_ohlc_summary (
        symbol, trading_date, open_price, high_price, low_price, close_price,
        volume, trade_count, turnover, vwap, is_finalized, finalized_at
    )
    SELECT
        agg.symbol, agg.trading_date, agg.open_price, agg.high_price,
        agg.low_price, agg.close_price, agg.volume, agg.trade_count,
        agg.turnover, agg.vwap, TRUE, now()
    FROM fn_aggregate_daily_ohlc(v_target_date, NULL) agg
    ON CONFLICT (symbol, trading_date)
    DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume = EXCLUDED.volume,
        trade_count = EXCLUDED.trade_count,
        turnover = EXCLUDED.turnover,
        vwap = EXCLUDED.vwap,
        is_finalized = TRUE,
        finalized_at = now(),
        updated_at = now();

    GET DIAGNOSTICS v_processed = ROW_COUNT;

    -- prev_close 업데이트
    UPDATE daily_ohlc_summary dos
    SET
        prev_close = prev_day.close_price,
        change_amount = dos.close_price - prev_day.close_price,
        change_percent = CASE
            WHEN prev_day.close_price > 0
            THEN ((dos.close_price - prev_day.close_price) / prev_day.close_price) * 100
            ELSE 0
        END,
        updated_at = now()
    FROM (
        SELECT symbol, close_price, trading_date
        FROM daily_ohlc_summary
        WHERE trading_date < v_target_date AND is_finalized = TRUE
        ORDER BY trading_date DESC
    ) prev_day
    WHERE dos.trading_date = v_target_date
      AND dos.symbol = prev_day.symbol
      AND dos.prev_close IS NULL;

    UPDATE daily_close_job_log
    SET status = 'completed',
        symbols_processed = v_processed,
        completed_at = now(),
        duration_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER
    WHERE id = v_job_id;

    RETURN v_processed;
END;
$$;

-- prevClose 업데이트 함수
CREATE OR REPLACE FUNCTION fn_update_prev_close(
    p_trading_date DATE DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
    v_processed INTEGER := 0;
BEGIN
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    INSERT INTO symbol_prev_close (symbol, prev_close, prev_trading_date, last_close, last_trading_date)
    SELECT dos.symbol, dos.close_price, dos.trading_date, dos.close_price, dos.trading_date
    FROM daily_ohlc_summary dos
    WHERE dos.trading_date = v_target_date AND dos.is_finalized = TRUE
    ON CONFLICT (symbol)
    DO UPDATE SET
        prev_close = EXCLUDED.prev_close,
        prev_trading_date = EXCLUDED.prev_trading_date,
        last_close = EXCLUDED.last_close,
        last_trading_date = EXCLUDED.last_trading_date,
        updated_at = now();

    GET DIAGNOSTICS v_processed = ROW_COUNT;
    RETURN v_processed;
END;
$$;

-- 일봉 생성 함수
CREATE OR REPLACE FUNCTION fn_generate_daily_candle(
    p_trading_date DATE DEFAULT NULL,
    p_symbol TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
    v_processed INTEGER := 0;
    v_epoch BIGINT;
BEGIN
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);
    v_epoch := EXTRACT(EPOCH FROM (v_target_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'));

    INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
    SELECT
        ch.symbol, '1d'::TEXT, v_epoch,
        TO_CHAR(v_target_date, 'YYYYMMDD') || '0000',
        (ARRAY_AGG(ch.open ORDER BY ch.time_epoch ASC))[1],
        MAX(ch.high), MIN(ch.low),
        (ARRAY_AGG(ch.close ORDER BY ch.time_epoch DESC))[1],
        SUM(ch.volume)
    FROM candle_history ch
    WHERE ch.interval = '1m'
      AND DATE(TO_TIMESTAMP(ch.time_epoch) AT TIME ZONE 'Asia/Seoul') = v_target_date
      AND (p_symbol IS NULL OR ch.symbol = LOWER(p_symbol))
    GROUP BY ch.symbol
    ON CONFLICT (symbol, interval, time_epoch)
    DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high,
        low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume;

    GET DIAGNOSTICS v_processed = ROW_COUNT;
    RETURN v_processed;
END;
$$;

-- 통합 마스터 함수
CREATE OR REPLACE FUNCTION fn_daily_close_master(
    p_trading_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
    v_finalized INTEGER;
    v_prev_close_updated INTEGER;
    v_candles_generated INTEGER;
    v_start_time TIMESTAMPTZ;
BEGIN
    v_start_time := clock_timestamp();
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    v_finalized := fn_finalize_daily_close(v_target_date);
    v_prev_close_updated := fn_update_prev_close(v_target_date);
    v_candles_generated := fn_generate_daily_candle(v_target_date, NULL);

    RETURN jsonb_build_object(
        'trading_date', v_target_date,
        'finalized_symbols', v_finalized,
        'prev_close_updated', v_prev_close_updated,
        'daily_candles_generated', v_candles_generated,
        'duration_ms', EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER,
        'executed_at', now()
    );
END;
$$;

RAISE NOTICE 'Functions created successfully';

-- ============================================================================
-- 4. pg_cron 작업 등록
-- ============================================================================

-- 기존 작업 제거 (안전)
DO $$
BEGIN
    PERFORM cron.unschedule('daily_close_master');
EXCEPTION WHEN OTHERS THEN
    NULL;
END
$$;

DO $$
BEGIN
    PERFORM cron.unschedule('generate_daily_candles');
EXCEPTION WHEN OTHERS THEN
    NULL;
END
$$;

DO $$
BEGIN
    PERFORM cron.unschedule('cleanup_old_logs');
EXCEPTION WHEN OTHERS THEN
    NULL;
END
$$;

-- 새 작업 등록
SELECT cron.schedule('daily_close_master', '5 15 * * *', 'SELECT fn_daily_close_master()');
SELECT cron.schedule('generate_daily_candles', '30 15 * * *', 'SELECT fn_generate_daily_candle()');
SELECT cron.schedule('cleanup_old_logs', '0 18 * * 6', 'DELETE FROM daily_close_job_log WHERE started_at < now() - INTERVAL ''30 days''');

RAISE NOTICE 'pg_cron jobs scheduled successfully';

-- ============================================================================
-- 5. 설치 완료 확인
-- ============================================================================
DO $$
DECLARE
    v_table_count INTEGER;
    v_function_count INTEGER;
    v_job_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_table_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('daily_ohlc_summary', 'symbol_prev_close', 'daily_close_job_log', 'active_symbols');

    SELECT COUNT(*) INTO v_function_count
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name LIKE 'fn_%daily%';

    SELECT COUNT(*) INTO v_job_count
    FROM cron.job
    WHERE jobname IN ('daily_close_master', 'generate_daily_candles', 'cleanup_old_logs');

    RAISE NOTICE '========================================';
    RAISE NOTICE 'Installation Complete!';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Tables created: %', v_table_count;
    RAISE NOTICE 'Functions created: %', v_function_count;
    RAISE NOTICE 'Cron jobs scheduled: %', v_job_count;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Verify with: SELECT * FROM cron.job;';
    RAISE NOTICE '2. Test with: SELECT fn_daily_close_master();';
    RAISE NOTICE '3. Check logs: SELECT * FROM daily_close_job_log;';
    RAISE NOTICE '========================================';
END
$$;
