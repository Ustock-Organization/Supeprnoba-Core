-- ============================================================================
-- RDS 기반 일일 마감 로직 - pg_cron 작업 스케줄
-- Finance Tracker 페르소나 설계
-- ============================================================================

-- ============================================================================
-- pg_cron 사용을 위한 사전 요구사항
-- ============================================================================
-- 1. AWS RDS Parameter Group 설정:
--    - shared_preload_libraries에 'pg_cron' 추가
--    - cron.database_name을 대상 데이터베이스로 설정 (예: 'postgres')
--
-- 2. Parameter Group 변경 후 RDS 인스턴스 재부팅 필요
--
-- 3. pg_cron 확장 생성 (최초 1회):
--    CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- 4. pg_cron 작업은 UTC 기준으로 스케줄됨
--    - KST 00:00 = UTC 15:00 (전일)
--    - KST 00:05 = UTC 15:05 (전일)
-- ============================================================================

-- 확장 활성화 확인
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE EXCEPTION 'pg_cron extension is not installed. Please run: CREATE EXTENSION pg_cron;';
    END IF;
END
$$;

-- ============================================================================
-- 1. 일일 마감 작업 (매일 KST 00:05, UTC 15:05 전일)
-- ============================================================================
-- 기존 작업 삭제 (중복 방지)
SELECT cron.unschedule('daily_close_master')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily_close_master');

-- 새 작업 등록
-- 매일 UTC 15:05 (KST 00:05)에 실행
SELECT cron.schedule(
    'daily_close_master',
    '5 15 * * *',  -- UTC 15:05 = KST 00:05
    $$SELECT fn_daily_close_master()$$
);

-- ============================================================================
-- 2. 일봉 생성 작업 (매일 KST 00:30, UTC 15:30 전일)
-- 메인 마감 작업 후 추가 안전장치
-- ============================================================================
SELECT cron.unschedule('generate_daily_candles')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'generate_daily_candles');

SELECT cron.schedule(
    'generate_daily_candles',
    '30 15 * * *',  -- UTC 15:30 = KST 00:30
    $$SELECT fn_generate_daily_candle()$$
);

-- ============================================================================
-- 3. 주간 정리 작업 (매주 일요일 KST 03:00, UTC 18:00 토요일)
-- 오래된 로그 정리
-- ============================================================================
SELECT cron.unschedule('cleanup_old_logs')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup_old_logs');

SELECT cron.schedule(
    'cleanup_old_logs',
    '0 18 * * 6',  -- UTC 토요일 18:00 = KST 일요일 03:00
    $$DELETE FROM daily_close_job_log WHERE started_at < now() - INTERVAL '30 days'$$
);

-- ============================================================================
-- 4. 작업 상태 확인 쿼리
-- ============================================================================
-- 등록된 cron 작업 목록 확인
-- SELECT * FROM cron.job;

-- 최근 작업 실행 이력 확인
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- 일일 마감 작업 로그 확인
-- SELECT * FROM daily_close_job_log ORDER BY started_at DESC LIMIT 20;

-- ============================================================================
-- 5. 수동 실행 예시
-- ============================================================================
-- 특정 날짜의 일일 마감 수동 실행
-- SELECT fn_daily_close_master('2025-01-11'::DATE);

-- 전일 마감 수동 실행 (기본값)
-- SELECT fn_daily_close_master();

-- 특정 심볼만 일봉 생성
-- SELECT fn_generate_daily_candle('2025-01-11'::DATE, 'TEST');

-- ============================================================================
-- 6. pg_cron 작업 관리 명령어
-- ============================================================================
-- 작업 비활성화 (일시 중지)
-- UPDATE cron.job SET active = FALSE WHERE jobname = 'daily_close_master';

-- 작업 활성화
-- UPDATE cron.job SET active = TRUE WHERE jobname = 'daily_close_master';

-- 작업 삭제
-- SELECT cron.unschedule('daily_close_master');

-- 작업 스케줄 변경 (매일 UTC 16:00으로 변경)
-- UPDATE cron.job SET schedule = '0 16 * * *' WHERE jobname = 'daily_close_master';

-- ============================================================================
-- 7. 모니터링 뷰 생성
-- ============================================================================
CREATE OR REPLACE VIEW v_daily_close_status AS
SELECT
    dcjl.trading_date,
    dcjl.job_name,
    dcjl.status,
    dcjl.symbols_processed,
    dcjl.duration_ms,
    dcjl.started_at,
    dcjl.completed_at,
    dcjl.error_message
FROM daily_close_job_log dcjl
ORDER BY dcjl.started_at DESC;

COMMENT ON VIEW v_daily_close_status IS '일일 마감 작업 상태 모니터링 뷰';

-- ============================================================================
-- 8. 알림용 함수 (실패 시 로깅)
-- pg_cron은 기본적으로 실패해도 알림이 없으므로 별도 모니터링 필요
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_check_daily_close_health()
RETURNS TABLE (
    status TEXT,
    last_successful_date DATE,
    last_failed_date DATE,
    pending_count INTEGER,
    message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_last_success DATE;
    v_last_fail DATE;
    v_pending INTEGER;
    v_today DATE;
BEGIN
    v_today := (now() AT TIME ZONE 'Asia/Seoul')::DATE;

    -- 마지막 성공 날짜
    SELECT MAX(trading_date) INTO v_last_success
    FROM daily_close_job_log
    WHERE status = 'completed' AND job_name = 'finalize_daily_close';

    -- 마지막 실패 날짜
    SELECT MAX(trading_date) INTO v_last_fail
    FROM daily_close_job_log
    WHERE status = 'failed' AND job_name = 'finalize_daily_close';

    -- 미확정 OHLC 개수 (당일 제외)
    SELECT COUNT(DISTINCT trading_date) INTO v_pending
    FROM daily_ohlc_summary
    WHERE is_finalized = FALSE
      AND trading_date < v_today;

    RETURN QUERY
    SELECT
        CASE
            WHEN v_last_success >= v_today - INTERVAL '1 day' THEN 'healthy'
            WHEN v_last_fail >= v_last_success THEN 'failed'
            ELSE 'warning'
        END as status,
        v_last_success as last_successful_date,
        v_last_fail as last_failed_date,
        v_pending as pending_count,
        CASE
            WHEN v_last_success >= v_today - INTERVAL '1 day' THEN 'Daily close is running normally'
            WHEN v_last_fail >= v_last_success THEN 'Recent daily close failed. Check logs.'
            ELSE 'Daily close may be delayed. Last success: ' || COALESCE(v_last_success::TEXT, 'never')
        END as message;
END;
$$;

COMMENT ON FUNCTION fn_check_daily_close_health IS
'일일 마감 작업 상태 확인. 모니터링/알림 시스템 연동용';
