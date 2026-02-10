# Supernoba Market Maker Service

> Admin Panel에서 제어하는 경량 마켓메이커

## 개요

Market Maker Service는 Admin 패널에서 설정한 종목에 대해 자동으로 매수/매도 주문을 발행하여 거래 데이터(캔들, 호가)를 생성합니다.

## 배포 정보

| 항목 | 값 |
|------|-----|
| **인스턴스** | `server` (stock-bastion) |
| **경로** | `~/Supeprnoba-Core/mm-service` |
| **실행 스크립트** | `./run_mm.sh` |
| **로그 파일** | `~/logs/mm-service.log` |

## 아키텍처

```
┌─────────────────┐     mm:control      ┌─────────────────┐
│  admin-mm       │ ─────────────────── │  mm-service     │
│  Lambda         │     (Pub/Sub)       │  (Node.js)      │
└─────────────────┘                     └────────┬────────┘
                                                 │
                                                 │ Kinesis (supernoba-orders)
                                                 ▼
                                        ┌─────────────────┐
                                        │  Matching       │
                                        │  Engine         │
                                        └────────┬────────┘
                                                 │ mm:status (Pub/Sub)
                                                 ▼
                                        ┌─────────────────┐
                                        │   Streamer      │
                                        │   → Frontend    │
                                        └─────────────────┘
```

## 주요 기능

1. **Control Channel 구독**: `mm:control` 채널에서 시작/정지 신호 수신
2. **주문 발행**: Kinesis `supernoba-orders` 스트림에 매수/매도 주문 발행
3. **상태 브로드캐스트**: `mm:status` 채널로 실시간 상태 발행
4. **설정 로드**: `mm:config:{SYMBOL}` HASH에서 종목별 설정 읽기

## Valkey 키 구조

> **참고**: 모든 MM 키는 **Operating Cache (포트 6382)** 에 저장됩니다.
> 환경변수: `OPERATING_CACHE_HOST` / `OPERATING_CACHE_PORT`

| 키 | 타입 | 설명 |
|----|------|------|
| `mm:control` | Pub/Sub | 제어 명령 채널 (start, stop, reload 등) |
| `mm:status` | Pub/Sub | 상태 브로드캐스트 채널 |
| `mm:running` | String | 전체 실행 상태 (1/0) |
| `mm:running:symbols` | Set | 실행 중인 종목 목록 |
| `mm:config:{SYMBOL}` | Hash | 종목별 MM 설정 |
| `mm:price:{SYMBOL}` | String | 현재 MM 가격 |
| `mm:started_at:{SYMBOL}` | String | 종목 시작 시간 |

## MM 설정 필드 (mm:config:{SYMBOL})

| 필드 | 설명 | 기본값 |
|------|------|--------|
| `basePrice` | 기준 가격 | 100 |
| `period` | 가격 주기 (초) | 600 |
| `amplitude` | 가격 진폭 (%) | 0.1 (10%) |
| `tickInterval` | 주문 발행 간격 (ms) | 1000 |
| `tradeQuantity` | 주문 수량 | 10 |

## 사용자 ID

| ID | 역할 |
|----|------|
| `mm-buyer` | 매수 주문 발행 |
| `mm-seller` | 매도 주문 발행 |

**참고**: 이 ID들은 order-router에서 잔고 검증을 우회해야 합니다.

## 배포 및 실행

```bash
# server 인스턴스에 SSH 접속
ssh server

# 코드 업데이트
cd ~/Supeprnoba-Core && git pull

# 서비스 실행
cd mm-service
./run_mm.sh          # 백그라운드 실행
./run_mm.sh --debug  # 포그라운드 실행 (디버그)

# 로그 확인
tail -f ~/logs/mm-service.log

# 서비스 종료
kill $(cat ~/logs/mm-service.pid)
```

## 관련 파일

| 파일 | 역할 |
|------|------|
| `index.mjs` | MM 서비스 메인 코드 |
| `run_mm.sh` | 실행 스크립트 |
| `package.json` | 의존성 정의 |
| `../lambda/Supernoba-admin-mm/index.mjs` | Admin MM Lambda (설정/제어) |

## 버전 히스토리

| 버전 | 변경사항 |
|------|----------|
| v7 | `mm:config` HASH 타입 지원 (HGETALL 사용) |
| v6 | 초기 버전 (STRING 타입 config) |
