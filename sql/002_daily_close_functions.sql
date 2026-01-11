-- ============================================================================
-- RDS 기반 일일 마감 로직 - Stored Functions
-- Finance Tracker 페르소나 설계
-- ============================================================================

-- ============================================================================
-- 1. 일일 OHLC 집계 함수
-- trade_history에서 특정 날짜의 OHLC를 집계
-- ============================================================================
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
            -- KST 기준 거래일
            DATE(th.created_at AT TIME ZONE 'Asia/Seoul') as trade_date
        FROM trade_history th
        WHERE DATE(th.created_at AT TIME ZONE 'Asia/Seoul') = p_trading_date
          AND (p_symbol IS NULL OR th.symbol = LOWER(p_symbol))
    ),
    first_last_trades AS (
        SELECT
            dt.symbol,
            -- 시가: 해당일 첫 체결가
            FIRST_VALUE(dt.price) OVER (
                PARTITION BY dt.symbol
                ORDER BY dt.created_at ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) as open_price,
            -- 종가: 해당일 마지막 체결가
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
        -- VWAP = 총 거래대금 / 총 거래량
        CASE
            WHEN SUM(flt.quantity) > 0
            THEN SUM(flt.price * flt.quantity) / SUM(flt.quantity)
            ELSE NULL
        END as vwap
    FROM first_last_trades flt
    GROUP BY flt.symbol;
END;
$$;

COMMENT ON FUNCTION fn_aggregate_daily_ohlc IS
'trade_history에서 일일 OHLC 집계. p_symbol이 NULL이면 전체 심볼 집계';


-- ============================================================================
-- 2. 일일 마감 확정 함수
-- 매일 자정(KST)에 실행하여 전일 데이터를 확정
-- ============================================================================
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
    v_error_msg TEXT;
BEGIN
    v_start_time := clock_timestamp();

    -- 대상 날짜: 파라미터가 없으면 전일(KST 기준)
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    -- 작업 로그 시작
    INSERT INTO daily_close_job_log (job_name, trading_date, status)
    VALUES ('finalize_daily_close', v_target_date, 'started')
    RETURNING id INTO v_job_id;

    BEGIN
        -- Step 1: trade_history에서 OHLC 집계하여 daily_ohlc_summary에 UPSERT
        INSERT INTO daily_ohlc_summary (
            symbol, trading_date, open_price, high_price, low_price, close_price,
            volume, trade_count, turnover, vwap, is_finalized, finalized_at
        )
        SELECT
            agg.symbol,
            agg.trading_date,
            agg.open_price,
            agg.high_price,
            agg.low_price,
            agg.close_price,
            agg.volume,
            agg.trade_count,
            agg.turnover,
            agg.vwap,
            TRUE,
            now()
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

        -- Step 2: 전일 종가(prev_close) 계산 및 업데이트
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
            SELECT
                symbol,
                close_price,
                trading_date
            FROM daily_ohlc_summary
            WHERE trading_date < v_target_date
              AND is_finalized = TRUE
            ORDER BY trading_date DESC
        ) prev_day
        WHERE dos.trading_date = v_target_date
          AND dos.symbol = prev_day.symbol
          AND dos.prev_close IS NULL;  -- 아직 prev_close가 없는 것만

        -- Step 3: 신규 상장 종목 (prev_close가 없는 경우) listing_price로 대체
        UPDATE daily_ohlc_summary dos
        SET
            prev_close = COALESCE(spc.listing_price, dos.open_price),
            change_amount = dos.close_price - COALESCE(spc.listing_price, dos.open_price),
            change_percent = CASE
                WHEN COALESCE(spc.listing_price, dos.open_price) > 0
                THEN ((dos.close_price - COALESCE(spc.listing_price, dos.open_price)) /
                      COALESCE(spc.listing_price, dos.open_price)) * 100
                ELSE 0
            END,
            updated_at = now()
        FROM symbol_prev_close spc
        WHERE dos.trading_date = v_target_date
          AND dos.symbol = spc.symbol
          AND dos.prev_close IS NULL;

        -- 작업 로그 완료
        UPDATE daily_close_job_log
        SET status = 'completed',
            symbols_processed = v_processed,
            completed_at = now(),
            duration_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER
        WHERE id = v_job_id;

    EXCEPTION WHEN OTHERS THEN
        v_error_msg := SQLERRM;

        UPDATE daily_close_job_log
        SET status = 'failed',
            error_message = v_error_msg,
            completed_at = now(),
            duration_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER
        WHERE id = v_job_id;

        RAISE WARNING 'fn_finalize_daily_close failed: %', v_error_msg;
    END;

    RETURN v_processed;
END;
$$;

COMMENT ON FUNCTION fn_finalize_daily_close IS
'일일 마감 확정 함수. 매일 자정(KST) pg_cron으로 실행';


-- ============================================================================
-- 3. prevClose 업데이트 함수
-- symbol_prev_close 테이블 업데이트 (Valkey 동기화용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_update_prev_close(
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
    v_error_msg TEXT;
BEGIN
    v_start_time := clock_timestamp();

    -- 대상 날짜: 파라미터가 없으면 전일(KST 기준)
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    -- 작업 로그 시작
    INSERT INTO daily_close_job_log (job_name, trading_date, status)
    VALUES ('update_prev_close', v_target_date, 'started')
    RETURNING id INTO v_job_id;

    BEGIN
        -- daily_ohlc_summary에서 확정된 종가를 symbol_prev_close에 UPSERT
        INSERT INTO symbol_prev_close (
            symbol, prev_close, prev_trading_date, last_close, last_trading_date
        )
        SELECT
            dos.symbol,
            dos.close_price,
            dos.trading_date,
            dos.close_price,
            dos.trading_date
        FROM daily_ohlc_summary dos
        WHERE dos.trading_date = v_target_date
          AND dos.is_finalized = TRUE
        ON CONFLICT (symbol)
        DO UPDATE SET
            prev_close = EXCLUDED.prev_close,
            prev_trading_date = EXCLUDED.prev_trading_date,
            last_close = EXCLUDED.last_close,
            last_trading_date = EXCLUDED.last_trading_date,
            updated_at = now();

        GET DIAGNOSTICS v_processed = ROW_COUNT;

        -- 작업 로그 완료
        UPDATE daily_close_job_log
        SET status = 'completed',
            symbols_processed = v_processed,
            completed_at = now(),
            duration_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER
        WHERE id = v_job_id;

    EXCEPTION WHEN OTHERS THEN
        v_error_msg := SQLERRM;

        UPDATE daily_close_job_log
        SET status = 'failed',
            error_message = v_error_msg,
            completed_at = now(),
            duration_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER
        WHERE id = v_job_id;

        RAISE WARNING 'fn_update_prev_close failed: %', v_error_msg;
    END;

    RETURN v_processed;
END;
$$;

COMMENT ON FUNCTION fn_update_prev_close IS
'전일 종가 업데이트 함수. fn_finalize_daily_close 실행 후 호출';


-- ============================================================================
-- 4. candle_history에서 일봉(1d) 생성 함수
-- 1분봉 데이터를 일봉으로 집계
-- ============================================================================
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
    -- 대상 날짜: 파라미터가 없으면 전일(KST 기준)
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    -- 일봉의 epoch: 해당일 00:00:00 KST의 Unix timestamp
    v_epoch := EXTRACT(EPOCH FROM (v_target_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'));

    -- 1분봉 데이터를 일봉으로 집계
    INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
    SELECT
        ch.symbol,
        '1d'::TEXT as interval,
        v_epoch as time_epoch,
        TO_CHAR(v_target_date, 'YYYYMMDD') || '0000' as time_ymdhm,
        -- 시가: 첫 1분봉의 open
        (ARRAY_AGG(ch.open ORDER BY ch.time_epoch ASC))[1] as open,
        MAX(ch.high) as high,
        MIN(ch.low) as low,
        -- 종가: 마지막 1분봉의 close
        (ARRAY_AGG(ch.close ORDER BY ch.time_epoch DESC))[1] as close,
        SUM(ch.volume) as volume
    FROM candle_history ch
    WHERE ch.interval = '1m'
      AND DATE(TO_TIMESTAMP(ch.time_epoch) AT TIME ZONE 'Asia/Seoul') = v_target_date
      AND (p_symbol IS NULL OR ch.symbol = LOWER(p_symbol))
    GROUP BY ch.symbol
    ON CONFLICT (symbol, interval, time_epoch)
    DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume;

    GET DIAGNOSTICS v_processed = ROW_COUNT;

    RETURN v_processed;
END;
$$;

COMMENT ON FUNCTION fn_generate_daily_candle IS
'1분봉에서 일봉 생성. candle_history 테이블에 1d interval로 저장';


-- ============================================================================
-- 5. 통합 일일 마감 함수 (Master Function)
-- 모든 일일 마감 작업을 순차적으로 실행
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_daily_close_master(
    p_trading_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
    v_result JSONB;
    v_finalized INTEGER;
    v_prev_close_updated INTEGER;
    v_candles_generated INTEGER;
    v_start_time TIMESTAMPTZ;
BEGIN
    v_start_time := clock_timestamp();

    -- 대상 날짜: 파라미터가 없으면 전일(KST 기준)
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    -- Step 1: 일일 OHLC 집계 및 마감 확정
    v_finalized := fn_finalize_daily_close(v_target_date);

    -- Step 2: prevClose 업데이트
    v_prev_close_updated := fn_update_prev_close(v_target_date);

    -- Step 3: 일봉 생성
    v_candles_generated := fn_generate_daily_candle(v_target_date, NULL);

    -- 결과 반환
    v_result := jsonb_build_object(
        'trading_date', v_target_date,
        'finalized_symbols', v_finalized,
        'prev_close_updated', v_prev_close_updated,
        'daily_candles_generated', v_candles_generated,
        'duration_ms', EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::INTEGER,
        'executed_at', now()
    );

    RAISE NOTICE 'Daily close completed: %', v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION fn_daily_close_master IS
'통합 일일 마감 함수. pg_cron으로 매일 자정(KST)에 실행';


-- ============================================================================
-- 6. 특정 심볼의 prevClose 조회 함수
-- C++ Engine이나 Lambda에서 조회용
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_prev_close(
    p_symbol TEXT
)
RETURNS TABLE (
    symbol TEXT,
    prev_close NUMERIC,
    prev_trading_date DATE,
    listing_price NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        spc.symbol,
        COALESCE(spc.prev_close, spc.listing_price) as prev_close,
        spc.prev_trading_date,
        spc.listing_price
    FROM symbol_prev_close spc
    WHERE spc.symbol = UPPER(p_symbol);

    -- 없으면 daily_ohlc_summary에서 최근 데이터 조회
    IF NOT FOUND THEN
        RETURN QUERY
        SELECT
            dos.symbol,
            dos.close_price as prev_close,
            dos.trading_date as prev_trading_date,
            NULL::NUMERIC as listing_price
        FROM daily_ohlc_summary dos
        WHERE dos.symbol = UPPER(p_symbol)
          AND dos.is_finalized = TRUE
        ORDER BY dos.trading_date DESC
        LIMIT 1;
    END IF;
END;
$$;

COMMENT ON FUNCTION fn_get_prev_close IS
'특정 심볼의 전일 종가 조회. Engine/Lambda 연동용';


-- ============================================================================
-- 7. 일일 OHLC 히스토리 조회 함수
-- 차트 API용
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_daily_ohlc_history(
    p_symbol TEXT,
    p_limit INTEGER DEFAULT 30,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    symbol TEXT,
    trading_date DATE,
    open_price NUMERIC,
    high_price NUMERIC,
    low_price NUMERIC,
    close_price NUMERIC,
    prev_close NUMERIC,
    volume NUMERIC,
    change_percent NUMERIC,
    time_epoch BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        dos.symbol,
        dos.trading_date,
        dos.open_price,
        dos.high_price,
        dos.low_price,
        dos.close_price,
        dos.prev_close,
        dos.volume,
        dos.change_percent,
        EXTRACT(EPOCH FROM (dos.trading_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'))::BIGINT as time_epoch
    FROM daily_ohlc_summary dos
    WHERE dos.symbol = UPPER(p_symbol)
      AND dos.is_finalized = TRUE
    ORDER BY dos.trading_date DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION fn_get_daily_ohlc_history IS
'일일 OHLC 히스토리 조회. Chart API용';
