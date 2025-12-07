# Liquibook AWS Wrapper

Liquibook 매칭 엔진을 AWS 환경 (EC2 + MSK + Redis)에서 운영하기 위한 C++ 네이티브 래퍼입니다.

## 빠른 시작 (EC2 Linux)

```bash
# 1. 소스 클론
git clone <YOUR_REPO>/liquibook.git
cd liquibook/wrapper

# 2. 빌드 (vcpkg 설치 및 의존성 포함)
chmod +x build_ec2.sh
./build_ec2.sh

# 3. 환경변수 설정
export KAFKA_BROKERS="b-1.msk-cluster.xxxxx.kafka.ap-northeast-2.amazonaws.com:9092"
export KAFKA_ORDER_TOPIC="orders"
export KAFKA_GROUP_ID="matching-engine-1"
export REDIS_HOST="redis.xxxxx.cache.amazonaws.com"
export REDIS_PORT="6379"
export GRPC_PORT="50051"

# 4. 실행
./build/matching_engine
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `KAFKA_BROKERS` | localhost:9092 | MSK 브로커 주소 |
| `KAFKA_ORDER_TOPIC` | orders | 주문 수신 토픽 |
| `KAFKA_GROUP_ID` | matching-engine | Consumer 그룹 ID |
| `KAFKA_FILLS_TOPIC` | fills | 체결 발행 토픽 |
| `KAFKA_TRADES_TOPIC` | trades | 거래 발행 토픽 |
| `KAFKA_DEPTH_TOPIC` | depth | 호가 발행 토픽 |
| `REDIS_HOST` | localhost | Redis 호스트 |
| `REDIS_PORT` | 6379 | Redis 포트 |
| `GRPC_PORT` | 50051 | gRPC 서버 포트 |
| `LOG_LEVEL` | INFO | 로그 레벨 (DEBUG/INFO/WARN/ERROR) |

## MSK 토픽 구조

**입력 (orders):**
```json
{"action":"ADD","order_id":"ord_123","symbol":"SAMSUNG","side":"BUY","price":72500,"quantity":100}
```

**출력 (fills):**
```json
{"event":"FILL","symbol":"SAMSUNG","order_id":"ord_123","fill_qty":50,"fill_price":72500}
```

## gRPC API

| 메서드 | 설명 |
|--------|------|
| `CreateSnapshot(symbol)` | 오더북 스냅샷 생성 → Redis + 응답 |
| `RestoreSnapshot(symbol, data)` | 오더북 복원 |
| `RemoveOrderBook(symbol)` | 오더북 제거 |
| `HealthCheck()` | 상태 확인 |

## 디렉토리 구조

```
wrapper/
├── CMakeLists.txt
├── vcpkg.json
├── build_ec2.sh      # EC2 빌드 스크립트
├── include/          # 헤더 파일
├── src/              # 소스 파일
├── proto/            # gRPC 프로토콜
└── test/             # 테스트
```
