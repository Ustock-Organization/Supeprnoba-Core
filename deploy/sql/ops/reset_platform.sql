-- ============================================================================
-- 플랫폼 전체 리셋 - RDS 데이터 삭제
-- 주의: 모든 거래 데이터가 삭제됩니다!
-- 사용법: ./run-sql.sh ops/reset_platform.sql
-- ============================================================================

\echo '=============================================='
\echo 'WARNING: Resetting ALL platform data!'
\echo '=============================================='

BEGIN;

-- 1. Market Maker 설정 초기화
TRUNCATE market_maker_configs RESTART IDENTITY CASCADE;
\echo 'Truncated market_maker_configs'

-- 2. 거래 히스토리 초기화
TRUNCATE trade_history RESTART IDENTITY CASCADE;
\echo 'Truncated trade_history'

-- 3. 캔들 히스토리 초기화
TRUNCATE candle_history RESTART IDENTITY CASCADE;
\echo 'Truncated candle_history'

-- 4. 일일 OHLC 요약 초기화
TRUNCATE daily_ohlc_summary RESTART IDENTITY CASCADE;
\echo 'Truncated daily_ohlc_summary'

-- 5. 전일종가 초기화
TRUNCATE symbol_prev_close RESTART IDENTITY CASCADE;
\echo 'Truncated symbol_prev_close'

-- 6. 활성 심볼 초기화
TRUNCATE active_symbols RESTART IDENTITY CASCADE;
\echo 'Truncated active_symbols'

-- 7. 일일 마감 작업 로그 초기화
TRUNCATE daily_close_job_log RESTART IDENTITY CASCADE;
\echo 'Truncated daily_close_job_log'

COMMIT;

\echo '=============================================='
\echo 'All RDS data has been reset'
\echo '=============================================='
