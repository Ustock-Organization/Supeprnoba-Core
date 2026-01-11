# RDS 기반 일일 마감 로직 설계

Finance Tracker 페르소나 설계 문서

## 개요

AWS Lambda/EventBridge 없이 RDS 내부에서 자동으로 일일 마감을 처리하는 시스템입니다.
pg_cron을 사용하여 매일 자정(KST)에 다음 작업을 자동 실행합니다:

1. 일일 OHLC 집계 및 마감 확정
2. prevClose 업데이트
3. 일봉(1d) 캔들 생성

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                     Aurora PostgreSQL                        │
│                                                              │
│  ┌──────────────┐    pg_cron (UTC 15:05)                    │
│  │ trade_history│ ────────────────────────┐                 │
│  └──────────────┘                         │                 │
│         │                                 ▼                 │
│         │                    ┌────────────────────────┐     │
│         │ 집계               │ fn_daily_close_master()│     │
│         ▼                    └───────────┬────────────┘     │
│  ┌──────────────────┐                    │                  │
│  │daily_ohlc_summary│◄───────────────────┤                  │
│  │  (확정 OHLC)     │                    │                  │
│  └──────────────────┘                    │                  │
│         │                                │                  │
│         │ prevClose                      │ 일봉 생성        │
│         ▼                                ▼                  │
│  ┌──────────────────┐          ┌─────────────────┐          │
│  │symbol_prev_close │          │ candle_history  │          │
│  │  (Valkey 백업)   │          │ (interval='1d') │          │
│  └──────────────────┘          └─────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                    │
                    │ Lambda/외부 프로세스가
                    │ 주기적으로 조회하여 동기화
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      Valkey Cache                            │
│                                                              │
│   prev:{SYMBOL}     ohlc:{SYMBOL}    candle:1d:{SYMBOL}     │
└─────────────────────────────────────────────────────────────┘
```

---

## 설치

### 사전 요구사항

1. **Aurora PostgreSQL 13.6+** 또는 **RDS PostgreSQL 12.5+**
2. **Parameter Group 설정**:
   ```
   shared_preload_libraries = 'pg_cron'
   cron.database_name = 'postgres'  # 대상 DB 이름
   ```
3. Parameter Group 변경 후 **RDS 인스턴스 재부팅**

### 설치 스크립트 실행

```bash
# 전체 설치 (권장)
psql -h <RDS_ENDPOINT> -U <USER> -d postgres -f 000_daily_close_install.sql

# 또는 개별 파일 순차 실행
psql -h <RDS_ENDPOINT> -U <USER> -d postgres -f 001_daily_close_tables.sql
psql -h <RDS_ENDPOINT> -U <USER> -d postgres -f 002_daily_close_functions.sql
psql -h <RDS_ENDPOINT> -U <USER> -d postgres -f 003_pg_cron_jobs.sql
psql -h <RDS_ENDPOINT> -U <USER> -d postgres -f 004_valkey_sync_functions.sql
```

---

## 테이블 구조

### daily_ohlc_summary
일일 OHLC 요약 데이터 (확정된 종가 포함)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| symbol | TEXT | 심볼 (PK) |
| trading_date | DATE | 거래일 (PK) |
| open_price | NUMERIC | 시가 |
| high_price | NUMERIC | 고가 |
| low_price | NUMERIC | 저가 |
| close_price | NUMERIC | 종가 |
| prev_close | NUMERIC | 전일 종가 |
| volume | NUMERIC | 거래량 |
| trade_count | INTEGER | 체결 건수 |
| turnover | NUMERIC | 거래대금 |
| change_percent | NUMERIC | 등락률 (%) |
| vwap | NUMERIC | 거래량 가중평균가 |
| is_finalized | BOOLEAN | 마감 확정 여부 |
| finalized_at | TIMESTAMPTZ | 마감 확정 시간 |

### symbol_prev_close
심볼별 전일 종가 관리 (Valkey 동기화용)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| symbol | TEXT | 심볼 (PK) |
| prev_close | NUMERIC | 전일 종가 |
| prev_trading_date | DATE | 전일 거래일 |
| listing_price | NUMERIC | 상장가 (fallback) |

### daily_close_job_log
일일 마감 작업 로그

| 컬럼 | 타입 | 설명 |
|------|------|------|
| job_name | TEXT | 작업 이름 |
| trading_date | DATE | 처리 대상 거래일 |
| status | TEXT | started/completed/failed |
| symbols_processed | INTEGER | 처리된 심볼 수 |
| duration_ms | INTEGER | 소요 시간 (ms) |

---

## 주요 함수

### fn_daily_close_master(p_trading_date DATE)
통합 일일 마감 함수. pg_cron으로 매일 자동 실행됩니다.

```sql
-- 전일 마감 실행 (기본값)
SELECT fn_daily_close_master();

-- 특정 날짜 마감 실행
SELECT fn_daily_close_master('2025-01-11'::DATE);
```

반환값:
```json
{
  "trading_date": "2025-01-11",
  "finalized_symbols": 15,
  "prev_close_updated": 15,
  "daily_candles_generated": 15,
  "duration_ms": 1234,
  "executed_at": "2025-01-12T00:05:00+09:00"
}
```

### fn_get_prev_close(p_symbol TEXT)
특정 심볼의 전일 종가 조회

```sql
SELECT * FROM fn_get_prev_close('TEST');
```

### fn_get_all_prev_close_for_sync()
전체 심볼의 prevClose 데이터 조회 (Valkey 동기화용)

```sql
SELECT * FROM fn_get_all_prev_close_for_sync();
```

---

## pg_cron 스케줄

| 작업 | 스케줄 (UTC) | KST | 설명 |
|------|-------------|-----|------|
| daily_close_master | 5 15 * * * | 00:05 | 일일 마감 |
| generate_daily_candles | 30 15 * * * | 00:30 | 일봉 생성 (백업) |
| cleanup_old_logs | 0 18 * * 6 | 일요일 03:00 | 로그 정리 |

### 스케줄 확인
```sql
SELECT * FROM cron.job;
```

### 실행 이력 확인
```sql
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```

---

## Valkey 동기화

PostgreSQL은 Valkey에 직접 쓸 수 없으므로, 외부 프로세스가 RDS를 조회하여 Valkey에 동기화해야 합니다.

### 권장 아키텍처

1. **Lambda + EventBridge** (별도 구현 필요)
   - 매일 KST 00:10에 실행
   - `fn_get_all_prev_close_for_sync()` 조회
   - Valkey `prev:{symbol}` 업데이트

2. **C++ Engine 시작 시**
   - `fn_get_prev_close()` 호출하여 prevClose 로드
   - 기존 `loadPrevClose()` 로직과 병행

### 동기화 쿼리 예시
```sql
-- 전체 심볼의 prevClose (Valkey JSON 포함)
SELECT symbol, valkey_json FROM fn_get_all_prev_close_for_sync();

-- 특정 날짜의 OHLC 데이터
SELECT * FROM fn_get_daily_ohlc_for_sync('2025-01-11');

-- 상위 변동률 종목
SELECT * FROM fn_get_top_movers('2025-01-11', 10);
```

---

## 모니터링

### 작업 상태 확인
```sql
SELECT * FROM fn_check_daily_close_health();
```

반환값:
```
 status  | last_successful_date | last_failed_date | pending_count | message
---------+---------------------+------------------+---------------+----------------------------
 healthy | 2025-01-11          |                  | 0             | Daily close is running normally
```

### 로그 확인
```sql
-- 최근 작업 로그
SELECT * FROM v_daily_close_status LIMIT 20;

-- 실패한 작업만
SELECT * FROM daily_close_job_log WHERE status = 'failed' ORDER BY started_at DESC;
```

---

## 트러블슈팅

### pg_cron이 실행되지 않음
1. Parameter Group에 `pg_cron` 추가 확인
2. RDS 인스턴스 재부팅
3. `CREATE EXTENSION pg_cron;` 실행

### 작업이 실패함
```sql
-- 오류 메시지 확인
SELECT * FROM daily_close_job_log WHERE status = 'failed' ORDER BY started_at DESC LIMIT 5;

-- 수동 재실행
SELECT fn_daily_close_master('2025-01-11'::DATE);
```

### prevClose가 NULL
1. 신규 상장 종목: `symbol_prev_close.listing_price` 설정
2. 거래 없는 날: 이전 거래일 종가 유지

```sql
-- listing_price 설정
SELECT fn_init_symbol_prev_close('TEST', 1000);
```

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|----------|
| 2025-01-12 | 초기 설계 문서 작성 (Finance Tracker 페르소나) |
