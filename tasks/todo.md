# AWS 인프라 엔진 수정 계획 (infra/aws)

> 2026-08-12 수립. 전제: 구 인프라 전멸(실측), 재구축 대상 계정 = aws-application-prod(342843238598, 워크스페이스 표준).
> 근거: 2026-08-12 전수조사 + 설계 리뷰(주문 블랙홀·정산 비멱등·복원 이중 진실원천 코드 검증 완료).
> 자매 브랜치 `infra/raspi`와의 차이를 "배포 설정 수준"으로 좁히는 것이 목표 — 엔진 코드는 최대한 공통.

## Phase 0 — 기준선 확보
- [ ] ext4 미러에서 wrapper/aggregator vcpkg 빌드 성립 확인 (신규 툴체인 첫 컴파일 → 잠복 결함 색출)
- [ ] 결정점 ①: 주문 유입 버스 — **SQS FIFO 전환(권고)** vs Kinesis 유지
      - SQS 채택 시: 고정비 제거 + ack 기반 소비(유실 구조 해소) + infra/raspi와 코드 공통화. Kinesis 유지 시 사유 기록할 것
- [ ] 결정점 ②: 이력·캔들 저장소 — DynamoDB 일원화(권고) vs RDS 유지

## Phase 1 — P0 신뢰성 (돈이 새는 구멍 봉인)
- [ ] 주문 유입 소비자 교체: KinesisConsumer → SQS FIFO 소비자(MessageGroupId=symbol, 처리 완료 시 삭제, DLQ)
      검증: 소비자 강제 kill→재기동 시 미ack 주문이 재전달되어 매칭됨
- [ ] 다운타임 주문 블랙홀 제거: PENDING 스위퍼(N분 초과 PENDING → 재주입 또는 잠금 해제 환불)
      검증: 엔진 정지 중 접수한 주문이 재기동 후 매칭되거나 환불됨 (현재는 영구 방치 — main.cpp:255 + dynamodb_client.cpp:56 필터)
- [ ] 산출(fills/status) 발행 신뢰화: WAL 자동 재생 경로 추가(현재 kinesis_producer.cpp:88 기록만 존재) 또는 SQS 전환으로 대체
      검증: 발행 실패 주입 후 재생으로 프로세서 도달 확인
- [ ] 종료 SEGV 수리: kinesis_consumer.cpp:194 stop 실패 시 detach → 타임아웃 join + 콜백 배리어
      검증: 부하 중 SIGTERM 100회 반복 크래시 0
- [ ] (cross-repo, Supernoba-back) 정산 멱등화: settlement#<trade_id> 조건부 항목을 TransactWrite에 포함
      검증: 동일 체결 2회 주입 → 잔고 1회만 변동

## Phase 2 — P1 시장 무결성
- [ ] STP(자전거래 방지): 매칭 직전 동일 user_id 대향 주문 거부 정책 (wrapper 레벨)
- [ ] 가격 콜라·시장규칙 엔진 내재화 (현재 Lambda 전처리 → MM/어드민 경로 미적용)
- [ ] 단일 리스크 게이트: MM·어드민 주문도 잔고/한도 검증 경유 (order-router:571 무잠금 직행 제거)
- [ ] gRPC 관리 채널 → 관리 큐(서명 검증) 전환 또는 mTLS (현재 무인증 평문 CancelAllOrders 노출)
- [ ] 복원 단일화: 입력 저널 재생 기반으로 재설계, DynamoDB 풀 스캔(Scan→GSI Query) 및 CLEAR_CHECKPOINTS_ON_START 정리
- [ ] 인바리언트 테스트 3종 신설(gtest 타깃): 매칭 골든 / 정산 멱등 / 잔고 보존 법칙

## Phase 3 — 배포 정비 (aws-application-prod 재구축)
- [ ] 배포 워크플로 재작성: 대상 계정 342843238598, OIDC 전환(정적 IAM 키 폐기 — 현재 4개 워크플로는 비활성화됨 2026-08-12)
- [ ] env 유령 노브 정리: KINESIS_ITERATOR_REFRESH_SECONDS·VALKEY_TLS 등 코드 미참조 변수 삭제 또는 배선
- [ ] 죽은 코드 정리: streamer C++판(452줄)·publishTrade/publishDepth·KAFKA_* 상수·liquiLegacy 비사용 트리
- [ ] NotificationClient(334줄, 하이버네이션 WIP) 처분 결정: 배선 or 삭제 (프로세서와 역할 중복)

## 검토 기록
- (진행하며 기입)
