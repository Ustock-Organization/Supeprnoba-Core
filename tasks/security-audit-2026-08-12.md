# Supernoba 거래소 전면 감사 — 2026-08-12

7개 병렬 적대적 감사(읽기 전용)의 교차검증 종합. 심각도 순.
담당: engine(매칭엔진), recovery(유입·복구), backend(정산), mm(마켓메이커), lambda(API), pipeline(시장데이터), admin(관리자).

**핵심 결론**: 지난 세션(2026-08-12 오전)에 "봉인했다"고 기록한 P0 방어 상당수가 실제로는 미완·회귀였다.
정산 멱등화는 미정산을 정산으로 봉인하는 회귀를 냈고, WAL 재생은 권한 문제로 프로덕션에서 작동 불가,
CPMM은 배선 안 된 죽은 코드, MM 5단계 방어선은 organic이 우회, gRPC 인증은 빈 토큰+페일오픈으로 실질 무인증.
리플레이 복구는 유실을 막기는커녕 오더북에 유령 주문을 만든다.

---

## 교차검증으로 2개 이상 에이전트가 독립 확인한 항목 (최고 신뢰)

| 사안 | 확인 에이전트 | 요지 |
|---|---|---|
| 리플레이 이중 등록 | recovery P0-1, engine P0-1 | `processed_orders_` 미복원 → dedup 무력 → 오더북 유령 주문 |
| 리플레이 체결이 현재 분봉 주입 | recovery P1-8, engine, pipeline P0-1 | 벽시계 스탬프 + 캔들 volume 가산 = 비멱등 |
| VI halt 소비자 0명 | engine P1-8, mm P1-4, pipeline P1-5 | `symbol:{S}:state` 읽는 코드 전무 → halt 미전파 |
| gRPC 관리채널 실질 무인증 | lambda P0-2, admin | 빈 토큰 출하 + 페일오픈 + 평문 |
| JWT `token_use`/`aud` 미검증 | lambda P1-3, pipeline #4, admin P2-11 | access_token 통용, 전 앱클라이언트 통용 |

---

## GROUP A — 익명→자금생성/시세조작 킬체인 (즉시)

- **A1 [admin P0-1]** `admin-mm/index.mjs:119-124`: `x-internal-call:true` 헤더로 관리자 인증 전면 우회. 익명이 MM 봇 전권 → `basePrice` 임의 주입 + `mm-` 계정은 STP 면제라 시세 조작 수익화. → 헤더 분기 삭제, 호출경로(requestContext 부재)로만 내부 판별.
- **A2 [admin P0-3]** `approval-handler/index.mjs:152-160`: `if(!ADMIN_API_KEY) return true` 페일오픈 + 인증실패 시 시크릿 원문 로그 출력 + 통과 시 무에서 holdings 발행. → fail-closed, verifyAdmin 교체, 로그 삭제.
- **A3 [admin P0-4 / lambda]** `ec2-mgmt/index.mjs:21`: `ADMIN_KEY || '7194'` 4자리 하드코딩. 무차별 1만회 이내 + 평문 커밋. (동일 값이 admin_config.json ADMIN_API_KEY에도 재사용). → verifyAdmin 교체, 리터럴 제거.
- **A4 [lambda P0-1]** `asset-handler/index.mjs:27-36`: 인증 전무. `?userId=x_victim`으로 임의 사용자 잔고·보유 노출. user_id 열거 용이. → verifySelf 삽입.
- **A5 [lambda P0-6]** `point-claim/index.mjs:124-158`: `/rewards/ad-complete` 상한·멱등·SSV 전무. 호출당 1000 BOLT 무한 발행. → SSV 검증 + 일일 카운터.
- **A6 [lambda P0-5]** `connect-handler/index.mjs:27-64`: WS 토큰 검증 실패해도 진행, 쿼리 `userId` 채택. 피해자 실시간 체결·잔고 데이터 탈취 + 정지 우회. → 토큰 성공 시에만 userId 채택.
- **A7 [lambda P0-2]** gRPC: `engine.env:36 ENGINE_GRPC_TOKEN=`(빈값) + `grpc_service.cpp:23-24` 페일오픈 + `createInsecure()`. VPC 도달자 누구나 CancelAllOrders/RemoveOrderBook. → 강토큰 필수화, 페일오픈 제거(빈토큰=기동거부), mTLS.

## GROUP B — 자금 정합성 (지난 세션 회귀 포함)

- **B1 [backend P0-1]** `fill_processor.cpp:68-77`: 원장 항목 0개여도 가드행 때문에 `empty()` 안전망 무력 → 잔고변경 0인데 SUCCESS + settlement_id 봉인 → 재처리도 ALREADY_SETTLED로 영구 스킵. **정산 멱등화(dc61090) 회귀.** → 가드 외 항목수 0이면 트랜잭션 실행 금지, false 반환.
- **B2 [backend P0-2]** 동일 지점: 한쪽만 성립한 트랜잭션을 가드가 원자 커밋 → 화폐/주식 창출 + 복구불가. → 양측 비-MM 항목 모두 성립 시에만 실행.
- **B3 [backend P0-3]** `supernoba-settlements` 테이블 부재(grep·describe 확인) + `enable_settlement_guard=true` 컴파일 기본값 + env 미정의. 재구축 즉시 체결 100% 유실. → 기본값 false or 기동 시 DescribeTable 검증.
- **B4 [lambda P0-3]** `reconciler/logic.mjs:14,37-47`: `PENDING_CANCEL` 부분체결 주문을 `created_at` 기준 stale 판정 후 `filled_qty` 무시하고 전액 재환불 → 이중환불 + locked 음수. **내가 만든 reconciler.** → filled_qty 반영 + `locked >= :amt` 조건.
- **B5 [lambda P0-4]** `order-router/index.mjs:321-334`: `unlockBalance`에 `locked >= :amt` 하한 없음(lock엔 있음). B4와 결합 시 음수 성립. → 조건식 추가.
- **B6 [admin P0-2]** `order-router:446-457,570-576`: 관리자 주문은 임의 user_id + 잠금 전면 스킵. 단일 관리자 = 무제한 자금생성·임의 유저간 가치이전. → 대리주문도 lock 적용(면제는 mm- 한정) + acting_admin 기록.
- **B7 [backend P1-6]** `dynamodb_client.cpp:377-406`: getHoldings/getWallet이 실패와 부재를 동일 nullopt로 뭉갬 → 매도측 GetItem 스로틀 시 주식 차감 없이 대금 지급(무담보 발행). → 실패/부재 구분.

## GROUP C — 엔진 무결성 (지난 세션 복구 로직이 오염원)

- **C1 [engine P0-1 / recovery P0-1]** 리플레이 이중 등록(위 교차검증). → restoreOrderBook에서 order_id를 processed_orders_ 시딩 + dedup 영속화.
- **C2 [engine P0-2]** `market_data_handler.cpp:206-217`: IOC/MARKET 주문이 `order_maps_`에 영구 잔류(on_cancel이 removeFilledOrderUnsafe 미호출) → 스냅샷이 price=0 유령 매도로 부활 → 복원 중 리스너 없이 매수호가 전체 무음 체결. → on_cancel에서 맵 제거.
- **C3 [engine P0-3]** `engine_core.cpp:459-460`: 스냅샷 복원 시 부분체결 주문이 원주문 수량 전체로 부활(OrderTracker가 filled_qty 모름) → 잠금수량 초과 체결. DynamoDB 경로는 정상. → 복원 시 setOrderQty(qty-filled), setFilledQty(0).
- **C4 [engine P0-4]** 복원 경로가 리스너 붙기 전 매칭 → 무음 체결. → 리스너 먼저 붙이거나 add() matched 반환 검사.
- **C5 [recovery P0-2]** `kinesis_producer.cpp:12` WAL_PATH가 root:root 디렉터리 직하 → ec2-user가 생성 불가(EACCES) → WAL 안전망이 프로덕션에서 한 번도 작동 안 함. → 경로를 /var/log/supernoba/engine/ 하위로.
- **C6 [recovery P0-3/P0-4]** restart()/종료 시 detach된 worker UAF + 이중소비(join 10s < drain 30s라 정상종료마다 detach). → join 대기 = drain+5s, detach 시 _exit.
- **C7 [pipeline P0-1]** 리플레이 체결이 현재 분봉 주입(위 교차검증) + 캔들 3계층 비멱등. → 원시 timestamp 버킷 + 리플레이 구간 발행 억제.
- **C8 [engine P1-6/P1-7]** VI 기준가가 halt 유발 체결가로 갱신 → 해제 후 조작가 정당화. 기준가가 "직전 체결"이라 다단 스윕/분할로 우회. → halt 시 기준가 동결, 시간앵커 기반 판정.
- **C9 [engine P1-9]** MARKET SELL(price=0)은 밴드 완전 우회, MARKET BUY는 오탐 거부. → 밴드를 체결가에 적용.
- **C10 [engine P1-8 / mm P1-4 / pipeline P1-5]** VI halt 미전파(위 교차검증) + halt 자동해제가 addOrder에만 의존해 얇은 종목 영구 고착. → state에 PUBLISH + setEx(TTL) + 메인루프 만료 스윕.
- **C11 [recovery P1-7]** 리플레이 중 발행 억제 없음 → 중복 fill/order-status 폭풍. → replay 플래그로 억제.

## GROUP D — MM (지난 세션 방어 상당수 미배선)

- **D1 [mm P0-1]** `cpmm.mjs` 전체가 죽은 코드(import처=테스트뿐) + 인메모리라 재시작마다 예산 y₀ 리셋. **M4 미배선.** → fill 훅에서 곡선 전진 + Redis 영속.
- **D2 [mm P0-2]** `organic-strategy.mjs:79-132`가 InventoryTracker 0회 호출 → 서킷브레이커·스큐 전부 우회 → 무제한 발권. **M1 우회.** → checkCircuitBreaker 삽입.
- **D3 [mm P0-3]** `legacy_sine`이 여전히 DEFAULT_CONFIG + 모든 폴백 종착지 + 화이트리스트 없어 오타 시 조용히 sine. 결정론 무위험 차익 부활. → default 분리 + 전략 화이트리스트.
- **D4 [mm P1-1]** 서킷브레이커 STOPPED가 기존 호가 미철회(return이 replaceOrders 앞) → 스테일 호가 방치. → return 전 cancelAllForSymbol.
- **D5 [mm P1-3]** publishStatus unhandled rejection → ElastiCache 페일오버 시 프로세스 즉사 → D1/D6 연쇄. → .catch() + unhandledRejection 핸들러.
- **D6 [mm P1-2]** OrderManager 인메모리 추적 → 크래시 시 고아 호가(리컨실러 미커버, MM주문은 DDB에 없음). → Redis 백업 + 기동 시 전량취소.

## GROUP E — 상장폐지·유저삭제 (데이터 정합)

- **E1 [lambda P0-7]** 상장폐지 보상 지급 코드 자체가 설계에 부재(grep 0건). 유저 보유주식 무보상 소멸. **제품 결정 선행 필요.**
- **E2 [lambda P0-8]** `delisting-phase4:229-237`: `Limit:1` + FilterExpression → 검증이 구조적으로 항상 통과 → 누락 있어도 COMPLETED. → Limit 제거 + LastEvaluatedKey 순회.
- **E3 [lambda P0-9]** `delete-user-phase2/3` 페이지네이션 누락 → 엔진에 유령 주문 생존 → 상대 유저 체결 롤백 or 좀비 holdings 재생성. → ExclusiveStartKey 순회.
- **E4 [pipeline P1-6]** delisting-phase3가 4-Cache를 1개로만 취급(type 누락→depth 폴백) → candle/ranking/state 잔존 → 폐지종목 랭킹·차트 부활. → 캐시별 클라이언트 4개.
- **E5 [lambda P1-7]** delisting-phase4:355 예약어 `phase` 미별칭 → 성공한 폐지가 FAILED 기록 + 캐시-job 불일치. → #phase 별칭.

## GROUP F — 소비 신뢰성 (Kinesis)

- **F1 [backend P1-1]** stock-processor Kinesis LATEST 고정 + 체크포인트 없음 + 에러 시 LATEST 재설정 → 정상 운영 중에도 백로그 유실. 스위퍼/리컨실러 미커버(ACCEPTED는 대상밖, lock 불변식 성립). → 시퀀스 체크포인트 + AFTER_SEQUENCE_NUMBER.
- **F2 [recovery P1-3/P1-6, backend P1-2]** 앵커 샤드 커버리지 축소→LATEST 폴백 유실 + 리샤딩 대응 전무(자식 샤드 영구 미소비). → 앵커 read-modify-write, NextShardIterator 빈값=종료 감지.
- **F3 [pipeline P0-2]** aggregator 재연결 부재 + RPOP 파괴적 소비 → Valkey 블립에 좀비화(무경보) + 캔들 영구유실. → 재연결 + ping 헬스체크 + LMOVE.
- **F4 [pipeline P1-8/P1-9]** 상위TF TTL 만료로 무거래 종목 일봉 누락·전일종가 고착 + depth/ticker TTL 없어 죽은 시장이 살아 보임. → 벽시계 강제마감 + TTL+stale 플래그.

## GROUP G — 관리자 거버넌스

- **G1 [admin P1-8]** audit-logs 테이블 부재 + 모든 감사기록이 예외 삼킴 + admin-mm/ws/symbol엔 감사코드 자체 없음 → 내부자 시세조작·자기잔고충전 무기록. → 테이블 프로비저닝 + 실패 시 작업 실패.
- **G2 [admin P1-9]** admin-ws-handler 쿼리스트링 토큰 + $connect 1회만 인가 + 신원 미바인딩 → 권한회수·만료 미반영, 조작자 특정 불가. → 헤더/Authorizer + 메시지별 재인가.
- **G3 [admin P1-6]** 공개 `?type=auth`가 요청자 제출 userId/email만으로 isAdmin 반환(토큰 대조 없음) → 관리자 UI 열람 + 계정 열거 오라클. → verifyAuth 필수 + 토큰 sub로만 조회.
- **G4 [admin P2-10]** setBalance/setHolding/setAdmin 상한·이중승인·version 잠금 부재 → 단일 관리자 무제한. → version 조건 + 한도 + 2인 승인.
- **G5 [admin P2-12/P1-5]** verifyAuth.mjs BOOTSTRAP_ADMINS 하드코딩 백도어 + devMode(POOL_ID 미설정 시 임의 사칭). → 배열 제거, devMode 제거.
- **G6 [admin P3]** YouTube/Twitter 실키가 git 이력 3커밋(b702f53,0e65225,9a21e37)에 잔존(현 브랜치는 Secrets Manager 전환). **유출 간주 → 폐기·재발급 + 히스토리 정리 필요(사용자 콘솔).**

## GROUP H — 빌드/배포 회귀

- **H1 [backend P1-9]** BUILD_TESTING 기본 ON + vcpkg에 gtest 없음 → 신규 환경 configure 실패. CI 테스트는 모델헤더만 커버(정산코드 0). settlement_guard_test/mm_inventory_test는 CI 미실행. → vcpkg gtest 추가 or 기본 OFF.
- **H2 [pipeline P3]** candle_history 스키마 2종 충돌(001_create_tables.sql vs aggregator/setup-postgres.sql) → 런북대로 구축 시 aggregator 전면 실패. → 스키마 일원화.
- **H3 [mm P3-2]** deploy-4cache.sh가 index.mjs 한 파일만 업로드 → import 실패로 MM 기동 불가(CI 경로는 정상). → 스크립트 삭제 or -r.

---

## 지난 세션 자기평가 정정

| 지난 세션 기록 | 실제 |
|---|---|
| "정산 멱등화 — 이중정산 봉인 ✅" | 미정산을 정산으로 봉인하는 **회귀**(B1/B2) + 테이블 부재로 100% 유실(B3) |
| "WAL 재생 ✅" | 권한으로 프로덕션 생성 불가(C5) + 리플레이가 오더북 오염(C1/C11) |
| "CPMM 유계손실 백스톱 ✅ (999001<100만 실증)" | **배선 안 된 죽은 코드**, 테스트 하네스 안에서만 성립(D1) |
| "MM M1 5단계 방어선 활성 ✅" | organic이 InventoryTracker 우회(D2), sine 여전히 기본값(D3) |
| "gRPC 관리채널 인증 ✅" | 빈 토큰 출하 + 페일오픈 = 실질 무인증(A7) |
| "VI 서킷브레이커 ✅ (state 전파)" | state 읽는 소비자 0명(C10), 얇은종목 영구고착, 다단스윕 우회(C8) |
| "종료 SEGV 수리 ✅" | 정상경로는 해소, detach 잔여창 존재(C6) |
| "가격밴드 ✅" | MARKET SELL 완전 우회, 복원 시 정상주문 소멸(C9, engine P1-10) |

수학 검증은 견고: OU 정확해·Hawkes 분기비<1·CTMC 정규화 모두 적대적 검증 통과(mm P3-1).
STP·밴드·halt 우선순위 로직, Apple IAP x5c 체인검증, Stripe 서명검증, auth layer RS256/JWKS는 정상.

---

---

# 조치 현황 (2026-08-12~13 수정 완료)

**GROUP A~H 전부 수정·검증·커밋·푸시 완료.** 커밋: Core `b3b9106`(A/B) `5bdfe81`(C)
`9239a8b`(D) `90cb85a`(E) `1337bde`(F) `4c5d7a2`(G/H), back `5a017fc`(B) `8fd94aa`(F) `0f5f215`(H).
develop·master·infra/raspi 전파 및 4브랜치 푸시 완료.

**검증**: 엔진 테스트 5종(stp·price_band·vi_halt·restore_integrity 신규 18건·journal) ALL PASS,
MM 4종(cpmm·inventory-skew·organic 신규 5건·price-process) ALL PASS,
백엔드 2종(settlement_guard·mm_inventory 14건 — **최초 실행**) ALL PASS,
Lambda 54개 문법 전수 통과, infra/aws·infra/raspi 양 브랜치 클린 빌드.

## 수정 중 발견한 신규 결함 (감사도 못 잡은 것)
- **IOC가 엔진에서 전혀 작동하지 않았다** (최대 발견): `addOrder`가 `book->add(order)`를
  conditions 없이 호출했고, liquibook의 주문 자체 플래그 폴백은 ①`LIQUIBOOK_ORDER_KNOWS_CONDITIONS`
  매크로로 비활성 ②멤버 초기화 후 지역 변수만 수정하는 버그라 무효. 결과: 모든 시장가 주문이
  미체결 시 취소되지 않고 북에 잔류. MARKET SELL은 price=0으로 남아 이후 매수를 전부 쓸어감.
  → `order->conditions()` 전달로 수정, 실측 검증.
- 엔진 테스트가 CMake에 아예 등록되지 않아 재현 불가였다 → `test/*_test.cpp` 자동 등록.
- `mm_inventory_test`는 어떤 CMakeLists에도 없어 한 번도 컴파일된 적이 없었다 → 등록 후 최초 실행, 14건 통과.

## 결함을 정답으로 고정하던 테스트 핀 3건 교체
- reconciler `logic.test`: "PENDING_CANCEL도 created_at 기준 대상" = 이중환불의 원인
- `organic-strategy.test`: `inventory: null`로도 통과 = 재고 방어선 미배선의 증거
- `settlement_guard_test`: "가드 기본 활성화" = 테이블 부재 시 체결 100% 유실

## 미조치 (사용자 결정·외부 작업 필요)
1. **E1 상장폐지 보상** — 지급 코드가 설계에 없음. 보상 정책(청산가 산정·지급 시점) 확정 선행 필요.
2. **G6 시크릿 재발급** — YouTube/Twitter 실키가 git 이력 3커밋(`b702f53`·`0e65225`·`9a21e37`)에 잔존.
   유출 간주하고 콘솔에서 폐기·재발급 필요(코드는 이미 Secrets Manager 전환됨).
3. **신규 인프라** — `supernoba-settlements`(PK settlement_id) · `supernoba-audit-logs` ·
   `supernoba-idempotency` 테이블, `Supernoba-reconciler` EventBridge 스케줄.
4. **env 주입** — `ENGINE_GRPC_TOKEN`(미설정 시 관리 채널 잠김) · `COGNITO_CLIENT_ID`(aud 검증) ·
   `ENABLE_SETTLEMENT_GUARD=true`(테이블 생성 후) · `BOOTSTRAP_ADMIN_SUBS`(최초 관리자 지정 후 제거).
5. **P2 이하 잔여** — 시장데이터 pub/sub 전환, 저장소 삼원화 일원화, 경매(C6),
   Stripe price_id 허용목록, 웹훅 처리 순서, CPMM 오더북 직접 투사.

---

## 착수 순서 (권고 — 완료됨)

1. **GROUP A 킬체인 봉인** (A1~A7) — 코드 소규모, 익명 자금생성 차단. 최우선.
2. **B1/B2 정산 회귀 + B3 테이블** — 내 회귀 즉시 교정. B3는 기본값 false로 임시 안전화.
3. **C1~C4 엔진 복원 오염** — 리플레이가 오염원이므로, 미봉합 전까지 RECOVERY_MODE=clear가 오히려 안전.
4. **D1~D3 MM 배선/기본값** — CPMM 배선, organic 방어선, sine 격리.
5. **F1 체크포인트, E2/E3 페이지네이션** — 유실 경로.
6. **G1 감사로그, G6 키 재발급** — 거버넌스.
7. **E1 상장폐지 보상** — 제품 결정 후.
