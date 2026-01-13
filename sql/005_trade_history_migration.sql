-- Trade History Schema Migration
-- 기존 Lambda 스키마 → C++ stock-processor 호환 스키마
-- 실행 전 백업 권장

-- 1. 새 컬럼 추가
ALTER TABLE public.trade_history
ADD COLUMN IF NOT EXISTS trade_id TEXT,
ADD COLUMN IF NOT EXISTS buyer_user_id TEXT,
ADD COLUMN IF NOT EXISTS seller_user_id TEXT,
ADD COLUMN IF NOT EXISTS buyer_is_maker BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

-- 2. 기존 데이터 마이그레이션 (기존 컬럼 → 새 컬럼)
UPDATE public.trade_history
SET
    trade_id = COALESCE(trade_id, id::TEXT),
    buyer_user_id = COALESCE(buyer_user_id, buyer_id::TEXT),
    seller_user_id = COALESCE(seller_user_id, seller_id::TEXT),
    executed_at = COALESCE(executed_at, created_at)
WHERE trade_id IS NULL OR buyer_user_id IS NULL;

-- 3. trade_id에 UNIQUE 인덱스 추가 (중복 방지)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_history_trade_id
ON public.trade_history (trade_id)
WHERE trade_id IS NOT NULL;

-- 4. 새 컬럼 인덱스 추가 (조회 성능)
CREATE INDEX IF NOT EXISTS idx_trade_history_buyer_user_id
ON public.trade_history (buyer_user_id);

CREATE INDEX IF NOT EXISTS idx_trade_history_seller_user_id
ON public.trade_history (seller_user_id);

CREATE INDEX IF NOT EXISTS idx_trade_history_executed_at
ON public.trade_history (executed_at);

-- 완료 확인
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'trade_history'
  AND table_schema = 'public'
ORDER BY ordinal_position;
