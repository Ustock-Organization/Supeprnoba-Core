# Supernoba 코드베이스 & 인프라 종합 최적화 — 작업 핸드오프

> **작업일**: 2026-03-16
> **상태**: 코드 변경 완료, **미커밋 / 미배포**
> **저장소**: `/mnt/c/develop/Supernoba-Core_Old`

---

## 1. 작업 요약

6개 병렬 감사 에이전트의 분석 결과를 기반으로, 비용·성능·유지보수성 개선을 위한 Phase 1-3 최적화를 코드 레벨에서 실행 완료.

| Phase | 항목 | 상태 |
|-------|------|------|
| 1-1 | Aggregator redisSetTimeout 추가 | **코드 완료** |
| 1-2 | WEBSOCKET_ENDPOINT 조사 | **조사 완료** (변경 없음) |
| 2-1 | resolveUserId → Auth Layer 통합 | **코드 완료** |
| 2-2 | pg Layer 생성 + 10 Lambda pg 제거 | **코드 완료** |
| 2-3 | @aws-sdk 번들 제거 (27 Lambda) | **코드 완료** |
| 3-1 | C++ Dead Code 삭제 (583줄) | **코드 완료** |
| 3-2 | 환경변수 localhost-override.env 통합 | **코드 완료** |
| 3-3 | Deploy 스크립트 공통 라이브러리 추출 | **코드 완료** |
| 4-* | 프론트엔드 분할, GitHub Actions, IAM | **미착수** (백로그) |

---

## 2. 변경 파일 상세

### Phase 1-1: Aggregator redisSetTimeout (CRITICAL)

**근거**: Engine에서 2026-02-06 동일 버그로 무한 hang 발생 이력. Engine은 수정됨(`redis_client.cpp:41-42`), Aggregator는 누락.

**변경 파일**:
```
M  aggregator/src/valkey_client.cpp
```

**변경 내용** (L86 `return true;` 앞에 4줄 추가):
```cpp
// Set command-level socket timeout (SO_RCVTIMEO/SO_SNDTIMEO)
// Without this, redisCommand() blocks indefinitely if connection drops mid-operation
struct timeval cmd_timeout = {3, 0};  // 3 seconds for read/write operations
redisSetTimeout(ctx_, cmd_timeout);
```

**리스크**: 극히 낮음 (기존 연결 흐름 변경 없이 타임아웃만 추가)

---

### Phase 1-2: WEBSOCKET_ENDPOINT 조사 (변경 없음)

**발견**:
- Core_Old `common.env:39` → `WEBSOCKET_ENDPOINT=l2ptm85wub` (Engine/Streamer용)
- Supernoba-back `common.env:42` → `WEBSOCKET_ENDPOINT=qbg5kmqm0c` (stock-processor용)
- `ADMIN_WEBSOCKET_ENDPOINT`는 양쪽 동일 (`sa1arlclz4`)
- 두 API GW ID가 다른 것은 Core_Old `common.env:38` 주석에 이미 "확인 필요"로 기록됨
- **결론**: 의도적 분리일 가능성 높음. 현재 정상 동작 중이므로 변경하지 않음

---

### Phase 2-1: resolveUserId → Auth Layer 통합

**배경**: 6개 Lambda에 동일한 `resolveUserId()` 함수(~32줄)가 복붙 존재. Auth Layer의 `verifySelf()`에도 거의 동일한 인라인 로직이 있었음.

**변경 파일 (7개)**:
```
M  lambda/layers/supernoba-auth/nodejs/verifyAuth.mjs   ← resolveUserId 추가, verifySelf 리팩토링
M  lambda/Supernoba-favorites/index.mjs                 ← 로컬 resolveUserId 삭제, import 변경
M  lambda/Supernoba-payments/index.mjs                  ← 동일
M  lambda/Supernoba-apple-iap/index.mjs                 ← 동일
M  lambda/Supernoba-delete-account/index.mjs            ← 동일
M  lambda/Supernoba-point-claim/index.mjs               ← 동일
M  lambda/Supernoba-push-tokens/index.mjs               ← 동일
```

**verifyAuth.mjs 변경 상세**:
1. L426-463: `export function resolveUserId(authResult)` 추가 (payments 버전 기준, 38줄)
2. L472-486: `verifySelf()` 내부 40줄 인라인 로직 → `resolveUserId(authResult)` 1줄 호출로 교체
3. L530: default export에 `resolveUserId` 추가

**6개 Lambda 변경 패턴** (모두 동일):
```javascript
// Before:
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';
function resolveUserId(authResult) { ... 32줄 ... }

// After:
import { verifyAuth, authErrorResponse, resolveUserId } from '/opt/nodejs/verifyAuth.mjs';
// (로컬 resolveUserId 함수 삭제)
```

**해석 순서 차이 참고**:
- 기존 `verifySelf` 인라인: identities 먼저 → cognito:username 폴백
- 새 `resolveUserId`: cognito:username 먼저 → identities 폴백
- 두 경로 모두 동일한 userId를 생성하므로 동작 변경 없음

**검증 방법**:
```bash
grep -r "function resolveUserId" lambda/
# 결과: layers/supernoba-auth/nodejs/verifyAuth.mjs:426 만 있어야 함
```

**배포**: Auth Layer **v24** publish → 6개 Lambda layer 버전 업데이트 필요

---

### Phase 2-2: pg Layer 생성

**배경**: 10개 Lambda가 각각 pg를 번들링 (버전 4종 혼재: 8.11.0~8.13.1)

**신규 파일**:
```
??  lambda/layers/supernoba-pg/nodejs/package.json    ← pg: ^8.13.1
```

**변경 파일 (10개 package.json에서 pg 의존성 제거)**:
```
M  lambda/Supernoba-admin/package.json
M  lambda/Supernoba-admin-mm/package.json
M  lambda/Supernoba-admin-stats/package.json
M  lambda/Supernoba-approval-handler/package.json
M  lambda/Supernoba-chart-data-handler/package.json
M  lambda/Supernoba-delete-user-phase4/package.json
M  lambda/Supernoba-delisting-phase3/package.json
M  lambda/Supernoba-delisting-phase4/package.json
M  lambda/Supernoba-history/package.json
M  lambda/Supernoba-symbol-admin/package.json
```

**검증 방법**:
```bash
grep -r '"pg"' lambda/*/package.json
# 결과: 0건이어야 함 (layers/supernoba-pg만 있어야 함)
```

**배포**:
1. `cd lambda/layers/supernoba-pg/nodejs && npm install`
2. Layer zip 생성 → `aws lambda publish-layer-version --layer-name supernoba-pg`
3. 10개 Lambda에 pg layer 연결 + 기존 node_modules에서 pg 제거 후 재배포

---

### Phase 2-3: @aws-sdk 번들 제거

**배경**: Node.js 20 Lambda Runtime에 AWS SDK v3가 내장됨. 28개 Lambda가 불필요하게 번들링.

**변경 파일 (34개 package.json)**:
```
M  lambda/Supernoba-admin/package.json
M  lambda/Supernoba-admin-core/package.json
M  lambda/Supernoba-admin-mm/package.json
M  lambda/Supernoba-admin-monitoring/package.json
M  lambda/Supernoba-admin-payments/package.json
M  lambda/Supernoba-admin-stats/package.json
M  lambda/Supernoba-admin-users/package.json
M  lambda/Supernoba-admin-ws-handler/package.json
M  lambda/Supernoba-apple-iap/package.json
M  lambda/Supernoba-approval-handler/package.json
M  lambda/Supernoba-asset-handler/package.json
M  lambda/Supernoba-auth/package.json              ← s3-request-presigner만 유지!
M  lambda/Supernoba-chart-data-handler/package.json
M  lambda/Supernoba-creator-requests/package.json
M  lambda/Supernoba-delete-user-phase4/package.json
M  lambda/Supernoba-delisting-phase1/package.json
M  lambda/Supernoba-delisting-phase2/package.json
M  lambda/Supernoba-delisting-phase3/package.json
M  lambda/Supernoba-delisting-phase4/package.json
M  lambda/Supernoba-ec2-mgmt/package.json
M  lambda/Supernoba-favorites/package.json
M  lambda/Supernoba-history/package.json
M  lambda/Supernoba-ipo-processor/package.json
M  lambda/Supernoba-order-router/package.json
M  lambda/Supernoba-payments/package.json
M  lambda/Supernoba-point-claim/package.json
M  lambda/Supernoba-preview-handler/package.json
M  lambda/Supernoba-push-sender/package.json
M  lambda/Supernoba-push-tokens/package.json
M  lambda/Supernoba-stripe-webhook/package.json
M  lambda/Supernoba-subscribe-handler/package.json
M  lambda/Supernoba-symbol-admin/package.json
M  lambda/Supernoba-symbol-cleanup/package.json
M  lambda/Supernoba-treemap-data/package.json
M  lambda/layers/supernoba-auth/nodejs/package.json ← Auth Layer에서도 제거
```

**유일한 예외**: `Supernoba-auth/package.json`의 `@aws-sdk/s3-request-presigner` — Lambda Runtime에 미포함

**검증 방법**:
```bash
grep -r "@aws-sdk" lambda/*/package.json lambda/layers/*/nodejs/package.json
# 결과: Supernoba-auth/package.json:s3-request-presigner 만 있어야 함
```

**배포**: 각 Lambda에서 `npm install` 재실행 → node_modules 축소 → 재배포
**효과**: Lambda당 5-15MB 절감, 총 ~150-400MB 스토리지 절감, 콜드스타트 개선

---

### Phase 3-1: C++ Dead Code 삭제 (583줄)

**배경**: CMakeLists.txt에 등록되지 않은 로컬 Redis Pub/Sub 모드 파일 5개가 소스 폴더에 잔존.

**삭제 파일**:
```
D  wrapper/src/main_local.cpp       (198줄)
D  wrapper/src/local_producer.cpp   (179줄)
D  wrapper/src/local_consumer.cpp   (107줄)
D  wrapper/include/local_producer.h  (62줄)
D  wrapper/include/local_consumer.h  (37줄)
```

**추가 삭제**: `wrapper/build_local/` 디렉토리 (오래된 빌드 아티팩트)

**리스크**: 없음 (CMakeLists.txt에 미등록, 프로덕션 빌드에 미포함)
**배포**: git commit만 (EC2 배포 불필요)

---

### Phase 3-2: 환경변수 localhost-override.env 통합

**배경**: 4개 서비스 env에 동일한 7줄 반복 (DEPTH_CACHE_HOST=127.0.0.1 등)

**신규 파일**:
```
??  deploy/env/localhost-override.env
```

내용:
```env
DEPTH_CACHE_HOST=127.0.0.1
BACKUP_CACHE_HOST=127.0.0.1
OPERATING_CACHE_HOST=127.0.0.1
CANDLE_CACHE_HOST=127.0.0.1
VALKEY_HOST=127.0.0.1
REDIS_HOST=127.0.0.1
VALKEY_TLS=false
```

**변경 파일 (8개)**:
```
M  deploy/env/engine.env              ← 7줄 localhost 오버라이드 삭제
M  deploy/env/streamer.env            ← 동일
M  deploy/env/mm-service.env          ← 동일
M  deploy/env/aggregator.env          ← 동일
M  deploy/systemd/supernoba-engine.service       ← EnvironmentFile 추가
M  deploy/systemd/supernoba-streamer.service     ← 동일
M  deploy/systemd/supernoba-mm.service           ← 동일
M  deploy/systemd/supernoba-aggregator.service   ← 동일
```

**systemd 변경 패턴** (4개 모두 동일):
```ini
# Before:
EnvironmentFile=/home/ec2-user/Supernoba-Core_Old/deploy/env/common.env
EnvironmentFile=/home/ec2-user/Supernoba-Core_Old/deploy/env/{service}.env

# After:
EnvironmentFile=/home/ec2-user/Supernoba-Core_Old/deploy/env/common.env
EnvironmentFile=/home/ec2-user/Supernoba-Core_Old/deploy/env/localhost-override.env  ← 추가
EnvironmentFile=/home/ec2-user/Supernoba-Core_Old/deploy/env/{service}.env
```

**주의**: systemd EnvironmentFile은 후순위 파일이 이전 값을 완전 덮어씀. 로딩 순서:
common.env (원격 ElastiCache) → localhost-override.env (127.0.0.1) → {service}.env (고유 설정)

**배포**: SCP → `sudo systemctl daemon-reload` → 서비스 순차 재시작

**검증**:
```bash
cat /proc/$(pidof matching_engine)/environ | tr '\0' '\n' | grep CACHE
# DEPTH_CACHE_HOST=127.0.0.1 등이 나와야 함
```

---

### Phase 3-3: Deploy 스크립트 공통 라이브러리

**배경**: 6개 배포 스크립트에 색상 정의 + 로깅 함수가 동일하게 반복.

**신규 파일**:
```
??  deploy/lib/common.sh
```

내용 (53줄):
```bash
# 색상 정의: RED, GREEN, YELLOW, BLUE, CYAN, NC
# 로깅 함수: log_info, log_success, log_warn, log_error
# 호스트별 서비스 매핑: HOST_SERVICES[], SERVICE_NAMES[]
# 환경변수 경로: DEPLOY_ENV_DIR
# Valkey 4-Cache 포트: DEPTH_PORT, CANDLE_PORT, BACKUP_PORT, OPERATING_PORT
```

**변경 파일 (6개 스크립트)**:
```
M  deploy/supernoba-ctl.sh        ← source lib/common.sh + 색상/로깅/HOST_SERVICES/SERVICE_NAMES 삭제
M  deploy/deploy-4cache.sh        ← source lib/common.sh + 색상/로깅 삭제 (log_phase 유지)
M  deploy/reset-platform.sh       ← source lib/common.sh + 색상/로깅 삭제
M  deploy/install-services.sh     ← source lib/common.sh + 색상/로깅 삭제
M  deploy/run-sql.sh              ← source lib/common.sh + 색상/로깅 삭제
M  deploy/delist-symbol.sh        ← source lib/common.sh + 색상/로깅 삭제
```

**standardization**: `log_success`를 `[OK]`로 통일 (일부 스크립트에서 `[SUCCESS]` 사용하던 것)

**배포**: SCP (lib/common.sh + 수정된 6개 스크립트)

---

## 3. 이 세션에서 변경하지 않은 파일들 (주의)

`git status`에 이 최적화와 **무관한 변경 파일**이 포함됨. 이전 세션에서의 미커밋 작업:

```
M  aggregator/include/aggregator.h        ← 이전 작업 (aggregator 관련)
M  aggregator/src/aggregator.cpp          ← 이전 작업
M  lambda/Supernoba-admin-mm/index.mjs    ← 이전 작업
M  lambda/Supernoba-admin-ws-handler/index.mjs ← 이전 작업
D  lambda/Supernoba-admin-ws-handler/package-lock.json ← 이전 작업
M  lambda/Supernoba-admin/index.mjs       ← 이전 작업
M  lambda/Supernoba-approval-handler/index.mjs ← 이전 작업
M  lambda/Supernoba-creator-requests/index.mjs ← 이전 작업
M  lambda/Supernoba-delisting-phase3/index.mjs ← 이전 작업
M  lambda/Supernoba-order-router/index.mjs ← 이전 작업
M  lambda/Supernoba-symbol-admin/index.mjs ← 이전 작업
M  lambda/layers/supernoba-common/nodejs/corsHeaders.mjs   ← 이전 작업
M  lambda/layers/supernoba-common/nodejs/index.mjs         ← 이전 작업
M  lambda/layers/supernoba-common/nodejs/secretsManager.mjs ← 이전 작업
M  lambda/layers/supernoba-common/nodejs/socialLinks.mjs   ← 이전 작업
M  lambda/layers/supernoba-common/nodejs/valkeyClient.mjs  ← 이전 작업
M  mm-service/strategies/depth-mm.mjs     ← 이전 작업
M  mm-service/strategies/sine-strategy.mjs ← 이전 작업
M  mm-service/strategies/spread-mm.mjs    ← 이전 작업
M  streamer/include/depth_broadcaster.h   ← 이전 작업
M  streamer/node/index.mjs               ← 이전 작업
M  streamer/src/depth_broadcaster.cpp     ← 이전 작업
```

커밋 시 **이 최적화 작업만** 분리하여 커밋하거나, 전체를 함께 커밋할지 판단 필요.

---

## 4. 배포 순서 (권장)

```
Step 1: Lambda Layer 배포 (서비스 중단 없음)
  1a. Auth Layer v24: cd lambda/layers/supernoba-auth → zip → publish-layer-version
  1b. pg Layer v1: cd lambda/layers/supernoba-pg/nodejs → npm install → zip → publish-layer-version

Step 2: Lambda 함수 배포 (서비스 중단 없음)
  2a. resolveUserId 6개 Lambda: layer 버전 업데이트 + 코드 배포
  2b. pg 10개 Lambda: pg layer 연결 + npm install(node_modules 축소) + 배포
  2c. @aws-sdk 27개 Lambda: npm install(node_modules 축소) + 배포
  ※ 2a-2c는 GitHub Actions deploy-lambda.yml로 일괄 배포 가능

Step 3: EC2 배포 (순차 재시작 필요)
  3a. valkey_client.cpp SCP → cmake build → sudo systemctl restart supernoba-aggregator
  3b. env + systemd + scripts SCP → sudo systemctl daemon-reload → 순차 재시작

Step 4: 검증
  4a. Aggregator: journalctl -u supernoba-aggregator -f (캔들 집계 정상 확인)
  4b. Auth Layer: 즐겨찾기 추가/삭제, 결제, 푸시 토큰 등록 테스트
  4c. pg Layer: chart-data-handler, history, admin RDS 쿼리 정상 확인
  4d. 환경변수: cat /proc/{pid}/environ | tr '\0' '\n' | grep CACHE
```

---

## 5. 예상 효과

| 항목 | 효과 |
|------|------|
| Aggregator timeout | Redis hang 방지 (가용성 향상) |
| resolveUserId 통합 | 6파일 → 1파일, ~192줄 중복 제거 |
| pg Layer | ~25MB 스토리지 절감, 버전 통일 (8.13.1) |
| @aws-sdk 제거 | ~150-400MB 스토리지 절감, 콜드스타트 개선 |
| C++ dead code | 583줄 제거 |
| 환경변수 정리 | 28줄 중복 → 7줄 1곳 |
| 스크립트 라이브러리 | ~60줄 중복 제거 |

---

## 6. 미실행 항목 (Phase 4 — 백로그)

- **프론트엔드 대형 파일 분할**: SymbolManagement.js (1,712줄), WebSocketService.js (1,018줄)
- **GitHub Actions 최적화**: deploy-lambda.yml npm install 중복 제거
- **IAM 역할 분리**: 현재 단일 Lambda 역할에 10개 FullAccess 정책 → 3그룹 분리
- **보너스 발견**: Supernoba-preview-handler에 @aws-sdk 3개가 dead dependency (이번에 제거됨)
