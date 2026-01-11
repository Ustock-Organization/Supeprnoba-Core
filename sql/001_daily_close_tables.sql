-- ============================================================================
-- RDS 기반 일일 마감 로직 - 테이블 정의
-- Finance Tracker 페르소나 설계
-- ============================================================================

-- 1. pg_cron 확장 활성화 (Aurora PostgreSQL에서 지원)
-- 주의: AWS RDS Parameter Group에서 shared_preload_libraries에 pg_cron 추가 필요
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 일일 OHLC 요약 테이블 (심볼별 일일 집계)
CREATE TABLE IF NOT EXISTS public.daily_ohlc_summary (
    id SERIAL,
    symbol TEXT NOT NULL,
    trading_date DATE NOT NULL,              -- 거래일 (KST 기준)
    open_price NUMERIC(18, 8) NOT NULL,      -- 시가
    high_price NUMERIC(18, 8) NOT NULL,      -- 고가
    low_price NUMERIC(18, 8) NOT NULL,       -- 저가
    close_price NUMERIC(18, 8) NOT NULL,     -- 종가
    prev_close NUMERIC(18, 8),               -- 전일 종가 (변동률 계산용)
    volume NUMERIC(24, 8) DEFAULT 0,         -- 거래량
    trade_count INTEGER DEFAULT 0,           -- 체결 건수
    turnover NUMERIC(24, 8) DEFAULT 0,       -- 거래대금 (price * quantity 합계)
    change_amount NUMERIC(18, 8) DEFAULT 0,  -- 등락폭 (close - prev_close)
    change_percent NUMERIC(10, 4) DEFAULT 0, -- 등락률 (%)
    vwap NUMERIC(18, 8),                     -- 거래량 가중 평균가
    is_finalized BOOLEAN DEFAULT FALSE,      -- 마감 확정 여부
    finalized_at TIMESTAMPTZ,                -- 마감 확정 시간
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (symbol, trading_date)
);

-- 인덱스: 날짜별 조회 최적화
CREATE INDEX IF NOT EXISTS idx_daily_ohlc_trading_date
    ON daily_ohlc_summary(trading_date);

-- 인덱스: 미확정 데이터 조회
CREATE INDEX IF NOT EXISTS idx_daily_ohlc_not_finalized
    ON daily_ohlc_summary(is_finalized) WHERE is_finalized = FALSE;

-- 3. 심볼별 prevClose 관리 테이블 (Valkey 백업용)
CREATE TABLE IF NOT EXISTS public.symbol_prev_close (
    symbol TEXT PRIMARY KEY,
    prev_close NUMERIC(18, 8) NOT NULL,           -- 전일 종가
    prev_trading_date DATE NOT NULL,              -- 전일 거래일
    last_close NUMERIC(18, 8),                    -- 최근 종가 (당일 포함)
    last_trading_date DATE,                       -- 최근 거래일
    listing_price NUMERIC(18, 8),                 -- 상장가 (fallback용)
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. 일일 마감 작업 로그 테이블
CREATE TABLE IF NOT EXISTS public.daily_close_job_log (
    id SERIAL PRIMARY KEY,
    job_name TEXT NOT NULL,                       -- 작업 이름
    trading_date DATE NOT NULL,                   -- 처리 대상 거래일
    status TEXT NOT NULL,                         -- 'started', 'completed', 'failed'
    symbols_processed INTEGER DEFAULT 0,          -- 처리된 심볼 수
    error_message TEXT,                           -- 오류 메시지
    started_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER                           -- 소요 시간 (밀리초)
);

CREATE INDEX IF NOT EXISTS idx_daily_close_job_log_date
    ON daily_close_job_log(trading_date, job_name);

-- 5. 심볼 활성화 목록 테이블 (Valkey active:symbols 백업)
CREATE TABLE IF NOT EXISTS public.active_symbols (
    symbol TEXT PRIMARY KEY,
    listing_price NUMERIC(18, 8),
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE daily_ohlc_summary IS '일일 OHLC 요약 - 매일 자정(KST) 마감 확정';
COMMENT ON TABLE symbol_prev_close IS '심볼별 전일종가 관리 - Valkey prev:{symbol} 백업';
COMMENT ON TABLE daily_close_job_log IS '일일 마감 작업 로그';
COMMENT ON TABLE active_symbols IS '활성 심볼 목록 - Valkey active:symbols 백업';
