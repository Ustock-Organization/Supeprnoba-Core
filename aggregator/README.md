# Candle Aggregator Service

실시간 캔들 집계 전용 C++ 서비스입니다.

## 기능

- Valkey에서 마감된 1분봉 감지 (100ms 폴링)
- 1분봉 → 3m/5m/15m/30m/1h/4h/1d/1w 타임프레임 집계
- DynamoDB candle_history 테이블 저장
- S3 supernoba-market-data 버킷 백업
- 처리 완료 후 Valkey closed 리스트 자동 삭제

## 구조

```
aggregator/
├── CMakeLists.txt       # CMake 빌드 설정
├── vcpkg.json           # 의존성 정의
├── run_aggregator.sh    # 턴키 실행 스크립트
├── include/
│   ├── config.h         # 설정 구조체
│   ├── logger.h         # 로깅 유틸
│   ├── valkey_client.h  # Valkey 클라이언트
│   ├── aggregator.h     # 집계 로직
│   ├── dynamodb_client.h
│   └── s3_client.h
└── src/
    ├── main.cpp         # 메인 루프
    ├── config.cpp
    ├── logger.cpp
    ├── valkey_client.cpp
    ├── aggregator.cpp
    ├── dynamodb_client.cpp
    └── s3_client.cpp
```

## EC2 배포

```bash
# 1. EC2에서 리포지토리 클론/업데이트
cd ~/liquibook
git pull

# 2. vcpkg 의존성 설치 (최초 1회)
cd aggregator
~/vcpkg/vcpkg install

# 3. 빌드 및 실행
./run_aggregator.sh

# 4. 옵션
./run_aggregator.sh --debug   # 디버그 로그
./run_aggregator.sh --dev     # 캐시 초기화 후 시작
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| VALKEY_HOST | supernoba-depth-cache... | Valkey 호스트 |
| VALKEY_PORT | 6379 | Valkey 포트 |
| AWS_REGION | ap-northeast-2 | AWS 리전 |
| DYNAMODB_CANDLE_TABLE | candle_history | DynamoDB 테이블 |
| S3_BUCKET | supernoba-market-data | S3 버킷 |
| POLL_INTERVAL_MS | 100 | 폴링 간격 (ms) |
| LOG_LEVEL | INFO | 로그 레벨 (DEBUG/INFO/WARN/ERROR) |
