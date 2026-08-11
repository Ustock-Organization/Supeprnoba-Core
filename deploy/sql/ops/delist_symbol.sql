-- ============================================================================
-- 상장폐지 RDS 데이터 삭제
-- 사용법: ./run-sql.sh ops/delist_symbol.sql symbol=TEST001
-- ============================================================================

\echo '=== Delisting symbol:' :symbol '==='

BEGIN;

-- 1. Market Maker 설정 삭제
DELETE FROM market_maker_configs WHERE symbol = :'symbol';
\echo 'Deleted from market_maker_configs'

-- 2. 거래 히스토리 삭제
DELETE FROM trade_history WHERE symbol = :'symbol';
\echo 'Deleted from trade_history'

-- 3. 캔들 히스토리 삭제
DELETE FROM candle_history WHERE symbol = :'symbol';
\echo 'Deleted from candle_history'

-- 4. 일일 OHLC 요약 삭제
DELETE FROM daily_ohlc_summary WHERE symbol = :'symbol';
\echo 'Deleted from daily_ohlc_summary'

-- 5. 전일종가 삭제
DELETE FROM symbol_prev_close WHERE symbol = :'symbol';
\echo 'Deleted from symbol_prev_close'

-- 6. 활성 심볼 목록에서 삭제
DELETE FROM active_symbols WHERE symbol = :'symbol';
\echo 'Deleted from active_symbols'

COMMIT;

\echo '=== RDS data deleted for symbol:' :symbol '==='
