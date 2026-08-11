# Supernoba SQL 관리

> RDS 스키마 및 운영 SQL 스크립트 관리

## 디렉토리 구조

```
sql/
├── schema/                 # 스키마 마이그레이션 (순차 실행)
│   └── 001_create_tables.sql
│
├── ops/                    # 운영 작업 스크립트
│   ├── delist_symbol.sql   # 상장폐지
│   └── reset_platform.sql  # 플랫폼 리셋
│
└── README.md
```

## 사용법

### SQL 실행 유틸리티

```bash
# 스키마 생성
./run-sql.sh schema/001_create_tables.sql

# 종목 상장폐지 (RDS 데이터만)
./run-sql.sh ops/delist_symbol.sql symbol=TEST001

# 플랫폼 리셋 (RDS 데이터만)
./run-sql.sh ops/reset_platform.sql
```

### 상장폐지 통합 스크립트

```bash
# 전체 상장폐지 (Valkey + RDS + DynamoDB)
./delist-symbol.sh TEST001
```

## 스크립트 설명

### schema/001_create_tables.sql

모든 RDS 테이블 스키마 정의:
- `daily_ohlc_summary` - 일일 OHLC 요약
- `symbol_prev_close` - 전일종가 관리
- `daily_close_job_log` - 일일 마감 작업 로그
- `active_symbols` - 활성 심볼 목록
- `candle_history` - 캔들 히스토리
- `trade_history` - 거래 히스토리
- `market_maker_configs` - Market Maker 설정

### ops/delist_symbol.sql

종목 상장폐지 시 RDS 데이터 삭제:
- 변수: `symbol` (종목 코드)

### ops/reset_platform.sql

플랫폼 전체 리셋 시 모든 RDS 데이터 TRUNCATE

## 주의사항

- `run-sql.sh`는 AWS Secrets Manager에서 RDS 자격 증명을 가져옴
- EC2 인스턴스의 IAM 역할에 `secretsmanager:GetSecretValue` 권한 필요
- 시크릿 이름: `supernoba/db-credentials`
