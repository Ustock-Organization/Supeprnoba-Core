-- pg_cron jobs 비활성화
-- Aggregator가 daily close 및 prev_close 관리를 담당하므로 pg_cron 비활성화

-- daily_close_master job 비활성화
UPDATE cron.job
SET active = FALSE
WHERE jobname = 'daily_close_master';

-- generate_daily_candles job 비활성화
UPDATE cron.job
SET active = FALSE
WHERE jobname = 'generate_daily_candles';

-- 비활성화 확인
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN ('daily_close_master', 'generate_daily_candles');

-- 롤백이 필요한 경우:
-- UPDATE cron.job SET active = TRUE WHERE jobname IN ('daily_close_master', 'generate_daily_candles');
