-- ============================================================================
-- Supernoba RDS 스키마 - IPO 주문 테이블
-- 실행: ./run-sql.sh schema/002_ipo_orders.sql
-- ============================================================================

-- IPO 주문 기록 테이블 (DynamoDB에서 이전)
CREATE TABLE IF NOT EXISTS public.ipo_orders (
    id SERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    quantity NUMERIC(24, 8) NOT NULL,
    price NUMERIC(18, 8) NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'ipo-system',
    order_id TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    processed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE(symbol)
);

CREATE INDEX IF NOT EXISTS idx_ipo_orders_status ON ipo_orders(status);

COMMENT ON TABLE ipo_orders IS 'IPO 주문 기록 (DynamoDB에서 이전)';
