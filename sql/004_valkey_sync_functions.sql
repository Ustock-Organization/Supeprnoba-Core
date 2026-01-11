-- ============================================================================
-- RDS 기반 일일 마감 로직 - Valkey 동기화용 쿼리
-- Finance Tracker 페르소나 설계
-- ============================================================================

-- ============================================================================
-- 이 파일의 쿼리들은 외부 애플리케이션(Lambda, C++ Engine 등)에서
-- RDS를 조회한 후 Valkey에 동기화할 때 사용합니다.
-- PostgreSQL 자체는 Valkey에 직접 쓸 수 없으므로 외부 연동이 필요합니다.
-- ============================================================================

-- ============================================================================
-- 1. 전체 심볼의 prevClose 데이터 조회 (Valkey 동기화용)
-- Lambda나 배치 프로세스에서 이 데이터를 조회하여 Valkey prev:{symbol}에 저장
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_all_prev_close_for_sync()
RETURNS TABLE (
    symbol TEXT,
    prev_close NUMERIC,
    prev_high NUMERIC,
    prev_low NUMERIC,
    prev_open NUMERIC,
    prev_volume NUMERIC,
    change_rate NUMERIC,
    trading_date DATE,
    -- Valkey prev:{symbol} 형식으로 직접 사용 가능한 JSON
    valkey_json TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH latest_finalized AS (
        SELECT DISTINCT ON (dos.symbol)
            dos.symbol,
            dos.close_price,
            dos.high_price,
            dos.low_price,
            dos.open_price,
            dos.volume,
            dos.change_percent,
            dos.trading_date
        FROM daily_ohlc_summary dos
        WHERE dos.is_finalized = TRUE
        ORDER BY dos.symbol, dos.trading_date DESC
    )
    SELECT
        lf.symbol,
        lf.close_price as prev_close,
        lf.high_price as prev_high,
        lf.low_price as prev_low,
        lf.open_price as prev_open,
        lf.volume as prev_volume,
        lf.change_percent as change_rate,
        lf.trading_date,
        -- Valkey prev:{symbol} JSON 형식
        json_build_object(
            'open', lf.open_price,
            'high', lf.high_price,
            'low', lf.low_price,
            'close', lf.close_price,
            'volume', lf.volume,
            'change_rate', lf.change_percent
        )::TEXT as valkey_json
    FROM latest_finalized lf;
END;
$$;

COMMENT ON FUNCTION fn_get_all_prev_close_for_sync IS
'Valkey prev:{symbol} 동기화용 전체 prevClose 데이터 조회';


-- ============================================================================
-- 2. 특정 날짜의 모든 심볼 OHLC 조회 (일괄 동기화용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_daily_ohlc_for_sync(
    p_trading_date DATE DEFAULT NULL
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
    valkey_ohlc_json TEXT,
    valkey_prev_json TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
BEGIN
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

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
        -- ohlc:{symbol} JSON
        json_build_object(
            'o', dos.open_price,
            'h', dos.high_price,
            'l', dos.low_price,
            'c', dos.close_price,
            'v', dos.volume,
            'change', dos.change_percent,
            't', EXTRACT(EPOCH FROM (dos.trading_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'))::BIGINT
        )::TEXT as valkey_ohlc_json,
        -- prev:{symbol} JSON (다음 거래일용)
        json_build_object(
            'open', dos.open_price,
            'high', dos.high_price,
            'low', dos.low_price,
            'close', dos.close_price,
            'volume', dos.volume,
            'change_rate', dos.change_percent
        )::TEXT as valkey_prev_json
    FROM daily_ohlc_summary dos
    WHERE dos.trading_date = v_target_date
      AND dos.is_finalized = TRUE;
END;
$$;

COMMENT ON FUNCTION fn_get_daily_ohlc_for_sync IS
'특정 날짜의 OHLC 데이터를 Valkey 동기화 형식으로 조회';


-- ============================================================================
-- 3. 신규 심볼 등록 시 prevClose 초기화 (listing_price 사용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_init_symbol_prev_close(
    p_symbol TEXT,
    p_listing_price NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO symbol_prev_close (
        symbol, prev_close, prev_trading_date, listing_price
    )
    VALUES (
        UPPER(p_symbol),
        p_listing_price,
        (now() AT TIME ZONE 'Asia/Seoul')::DATE,
        p_listing_price
    )
    ON CONFLICT (symbol)
    DO UPDATE SET
        listing_price = p_listing_price,
        updated_at = now()
    WHERE symbol_prev_close.listing_price IS NULL
       OR symbol_prev_close.listing_price != p_listing_price;
END;
$$;

COMMENT ON FUNCTION fn_init_symbol_prev_close IS
'신규 심볼의 prevClose 초기화. listing_price를 초기 prevClose로 설정';


-- ============================================================================
-- 4. 심볼별 일봉 히스토리 조회 (Valkey candle:1d:{symbol} 백필용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_daily_candles_for_backfill(
    p_symbol TEXT,
    p_days INTEGER DEFAULT 365
)
RETURNS TABLE (
    symbol TEXT,
    time_epoch BIGINT,
    time_ymdhm TEXT,
    open_price NUMERIC,
    high_price NUMERIC,
    low_price NUMERIC,
    close_price NUMERIC,
    volume NUMERIC,
    -- Lightweight Charts 형식
    chart_data_json TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        dos.symbol,
        EXTRACT(EPOCH FROM (dos.trading_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'))::BIGINT as time_epoch,
        TO_CHAR(dos.trading_date, 'YYYYMMDD') || '0000' as time_ymdhm,
        dos.open_price,
        dos.high_price,
        dos.low_price,
        dos.close_price,
        dos.volume,
        -- TradingView Lightweight Charts 형식
        json_build_object(
            'time', EXTRACT(EPOCH FROM (dos.trading_date::TIMESTAMP AT TIME ZONE 'Asia/Seoul'))::BIGINT,
            'open', dos.open_price,
            'high', dos.high_price,
            'low', dos.low_price,
            'close', dos.close_price
        )::TEXT as chart_data_json
    FROM daily_ohlc_summary dos
    WHERE dos.symbol = UPPER(p_symbol)
      AND dos.is_finalized = TRUE
      AND dos.trading_date >= (now() AT TIME ZONE 'Asia/Seoul')::DATE - (p_days || ' days')::INTERVAL
    ORDER BY dos.trading_date ASC;
END;
$$;

COMMENT ON FUNCTION fn_get_daily_candles_for_backfill IS
'일봉 히스토리 데이터 백필용. TradingView 차트 형식 포함';


-- ============================================================================
-- 5. 변동률 상위 종목 조회 (Valkey 캐시용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_top_movers(
    p_trading_date DATE DEFAULT NULL,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    rank INTEGER,
    symbol TEXT,
    close_price NUMERIC,
    prev_close NUMERIC,
    change_amount NUMERIC,
    change_percent NUMERIC,
    volume NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
BEGIN
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    RETURN QUERY
    SELECT
        ROW_NUMBER() OVER (ORDER BY ABS(dos.change_percent) DESC)::INTEGER as rank,
        dos.symbol,
        dos.close_price,
        dos.prev_close,
        dos.change_amount,
        dos.change_percent,
        dos.volume
    FROM daily_ohlc_summary dos
    WHERE dos.trading_date = v_target_date
      AND dos.is_finalized = TRUE
      AND dos.change_percent IS NOT NULL
    ORDER BY ABS(dos.change_percent) DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION fn_get_top_movers IS
'변동률 상위 종목 조회. 대시보드/Valkey 캐시용';


-- ============================================================================
-- 6. 거래량 상위 종목 조회 (Valkey 캐시용)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_top_volume(
    p_trading_date DATE DEFAULT NULL,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    rank INTEGER,
    symbol TEXT,
    close_price NUMERIC,
    change_percent NUMERIC,
    volume NUMERIC,
    turnover NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_target_date DATE;
BEGIN
    v_target_date := COALESCE(p_trading_date,
        (now() AT TIME ZONE 'Asia/Seoul' - INTERVAL '1 day')::DATE);

    RETURN QUERY
    SELECT
        ROW_NUMBER() OVER (ORDER BY dos.volume DESC)::INTEGER as rank,
        dos.symbol,
        dos.close_price,
        dos.change_percent,
        dos.volume,
        dos.turnover
    FROM daily_ohlc_summary dos
    WHERE dos.trading_date = v_target_date
      AND dos.is_finalized = TRUE
    ORDER BY dos.volume DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION fn_get_top_volume IS
'거래량 상위 종목 조회. 대시보드/Valkey 캐시용';
