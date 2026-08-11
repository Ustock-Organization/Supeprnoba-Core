# Supernoba 배포 자동화

> systemd 서비스 기반의 프로덕션 배포 자동화 시스템

## 특징

- **호스트명 기반 서비스 자동 감지**: 인스턴스 호스트명으로 실행할 서비스 결정
- **동적 메모리 할당**: 인스턴스 메모리의 90% 이내 자동 설정
- **자동 재시작**: 장애 발생 시 5초 후 자동 재시작
- **로그 로테이션**: 일별 로테이션, 7일 보관, 자동 압축
- **레거시 프로세스 정리**: nohup/&로 실행된 프로세스 강제 종료

---

## 디렉토리 구조

```
deploy/
├── env/                        # 환경변수 파일
│   ├── common.env              # 공통 (AWS, Valkey, Kinesis 등)
│   ├── engine.env              # Matching Engine
│   ├── streamer.env            # Streamer
│   ├── mm-service.env          # MM Service
│   ├── aggregator.env          # Candle Aggregator
│   └── processor.env           # Stock Processor
├── systemd/                    # systemd 서비스 파일
│   ├── supernoba-engine.service
│   ├── supernoba-streamer.service
│   ├── supernoba-mm.service
│   ├── supernoba-aggregator.service
│   └── supernoba-processor.service
├── logrotate/                  # 로그 로테이션 설정
│   ├── install-logrotate.sh
│   └── supernoba-*
├── install-services.sh         # 서비스 설치 스크립트
├── supernoba-ctl.sh           # 마스터 제어 스크립트
└── reset-platform.sh          # 플랫폼 초기화 스크립트
```

---

## 설치

### 1. 서비스 설치 (최초 1회, root 필요)

```bash
cd ~/Supernoba-Core_Old/deploy
sudo ./install-services.sh
```

설치 스크립트가 자동으로:
- 로그 디렉토리 생성 (`/var/log/supernoba/`)
- systemd 서비스 파일 설치 (동적 메모리 제한 적용)
- logrotate 설정 설치
- 호스트명 기반 서비스 선택

### 2. RDS 비밀번호 설정

```bash
mkdir -p ~/.secrets
echo 'RDS_PASSWORD=your_password' > ~/.secrets/rds.env
chmod 600 ~/.secrets/rds.env
```

### 3. 서비스 활성화 및 시작

```bash
./supernoba-ctl.sh enable all    # 부팅 시 자동 시작 활성화
./supernoba-ctl.sh start all     # 서비스 시작
./supernoba-ctl.sh health        # 상태 확인
```

---

## 명령어 참조

### supernoba-ctl.sh

마스터 제어 스크립트. 호스트명 기반으로 해당 인스턴스의 서비스만 제어.

```bash
./supernoba-ctl.sh <action> [service]
```

| 명령 | 설명 | 예시 |
|------|------|------|
| `start [service]` | 서비스 시작 | `./supernoba-ctl.sh start all` |
| `stop [service]` | 서비스 종료 | `./supernoba-ctl.sh stop engine` |
| `restart [service]` | 서비스 재시작 | `./supernoba-ctl.sh restart mm` |
| `status [service]` | 상태 확인 | `./supernoba-ctl.sh status` |
| `logs <service>` | 로그 tail -f | `./supernoba-ctl.sh logs streamer` |
| `enable [service]` | 부팅 시 자동 시작 | `./supernoba-ctl.sh enable all` |
| `disable [service]` | 자동 시작 해제 | `./supernoba-ctl.sh disable mm` |
| `health` | 헬스체크 | `./supernoba-ctl.sh health` |
| `deploy` | 전체 배포 (pull+build+restart) | `./supernoba-ctl.sh deploy` |
| `kill [service]` | 프로세스 강제 종료 | `./supernoba-ctl.sh kill engine` |
| `kill-all` | 모든 Supernoba 프로세스 종료 | `./supernoba-ctl.sh kill-all` |

**서비스명:** `engine`, `streamer`, `mm`, `aggregator`, `processor`, `all`

### reset-platform.sh

플랫폼 전체 데이터 초기화. **주의: 모든 데이터가 삭제됩니다!**

```bash
./reset-platform.sh --dry-run     # 삭제 대상 확인만 (실제 삭제 안함)
./reset-platform.sh --confirm     # 실제 삭제 실행
```

초기화 대상:
- **DynamoDB**: supernoba-orders, supernoba-holdings, supernoba-wallets
- **PostgreSQL**: trade_history, candle_history
- **Valkey**: depth:*, candle:*, ticker:*, mm:*, user:*, ws:*

---

## 호스트별 서비스 매핑

스크립트가 호스트명을 자동 감지하여 해당 서비스만 제어:

| 호스트명 패턴 | 자동 실행 서비스 | systemd 서비스명 |
|--------------|----------------|-----------------|
| `stock-bastion` | engine, mm | supernoba-engine, supernoba-mm |
| `stock-streamer` | streamer | supernoba-streamer |
| `stock-processor` | processor | supernoba-processor |
| `stock-aggregator` | aggregator | supernoba-aggregator |

---

## 메모리 할당

`install-services.sh`가 인스턴스 메모리를 자동 감지하여 서비스별 메모리 제한 설정:

| 서비스 | 비율 | 2GB 인스턴스 | 4GB 인스턴스 | 8GB 인스턴스 |
|--------|------|-------------|-------------|-------------|
| engine | 60% | 1.2G | 2.4G | 4.8G |
| mm | 20% | 400M | 800M | 1.6G |
| streamer | 80% | 1.6G | 3.2G | 6.4G |
| processor | 80% | 1.6G | 3.2G | 6.4G |
| aggregator | 80% | 1.6G | 3.2G | 6.4G |

**참고:** 동일 호스트에서 여러 서비스 실행 시 합이 90% 이하가 되도록 설정됨.

### Node.js V8 힙 크기

Node.js 서비스(mm, streamer)는 서비스 메모리의 70%를 V8 힙으로 할당:
- 예: mm 서비스 800MB → V8 힙 560MB (`--max-old-space-size=560`)

---

## 로그 관리

### 로그 경로

| 서비스 | 로그 경로 |
|--------|----------|
| engine | `/var/log/supernoba/engine/engine.log` |
| streamer | `/var/log/supernoba/streamer/streamer.log` |
| mm | `/var/log/supernoba/mm-service/mm-service.log` |
| aggregator | `/var/log/supernoba/aggregator/aggregator.log` |
| processor | `/var/log/supernoba/processor/processor.log` |

### 로그 로테이션 설정

- **주기**: 일별 (daily)
- **보관**: 7일
- **압축**: delaycompress (하루 지연 후 gzip 압축)
- **형식**: `service.log-20260118.gz`

---

## 환경변수

### common.env (공통)

```bash
# AWS
AWS_REGION=ap-northeast-2
AWS_DEFAULT_REGION=ap-northeast-2

# Valkey 4-Cache (EC2: localhost, Lambda: ElastiCache 엔드포인트)
DEPTH_CACHE_HOST=127.0.0.1
DEPTH_CACHE_PORT=6379
CANDLE_CACHE_HOST=127.0.0.1
CANDLE_CACHE_PORT=6380
BACKUP_CACHE_HOST=127.0.0.1
BACKUP_CACHE_PORT=6381
OPERATING_CACHE_HOST=127.0.0.1
OPERATING_CACHE_PORT=6382

# Kinesis
ORDERS_STREAM=supernoba-orders
FILLS_STREAM=supernoba-fills
ORDER_STATUS_STREAM=supernoba-order-status

# DynamoDB
ORDERS_TABLE=supernoba-orders
HOLDINGS_TABLE=supernoba-holdings
WALLETS_TABLE=supernoba-wallets
SYMBOLS_TABLE=supernoba-symbols
```

### 서비스별 환경변수

각 서비스는 common.env + 서비스별 env 파일을 로드:
- `engine.env`: 엔진 전용 설정
- `streamer.env`: 스트리머 폴링 간격 등
- `mm-service.env`: MM 전용 설정
- `aggregator.env`: RDS 연결 정보
- `processor.env`: RDS 연결 정보, Kinesis 컨슈머 설정

---

## 문제 해결

### 서비스가 시작되지 않음

```bash
# 1. 상태 확인
sudo systemctl status supernoba-engine

# 2. 로그 확인
journalctl -u supernoba-engine -f
tail -f /var/log/supernoba/engine/engine.log

# 3. 환경변수 확인
cat /home/ec2-user/Supernoba-Core_Old/deploy/env/engine.env
```

### 메모리 부족으로 종료됨

```bash
# OOM Killer 로그 확인
dmesg | grep -i "killed process"

# 서비스 메모리 제한 확인
systemctl show supernoba-engine | grep -i memory
```

### 레거시 프로세스 정리

systemd 서비스 시작 전 기존 nohup 프로세스 정리:

```bash
./supernoba-ctl.sh kill-all
./supernoba-ctl.sh start all
```

---

## 보안 고려사항

- **RDS 비밀번호**: `~/.secrets/rds.env`에 저장, 권한 600
- **환경변수 파일**: Git에 민감 정보 포함 금지
- **플랫폼 초기화**: 이중 확인 (`--confirm` + "DELETE ALL" 입력)

---

*마지막 업데이트: 2026-01-18*
