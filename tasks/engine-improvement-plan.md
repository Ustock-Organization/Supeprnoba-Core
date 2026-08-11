# 트레이딩 엔진 개선 계획 — 리서치 2종 종합 (2026-08-12)

> 근거: 엔진 아키텍처 리서치(LMAX·시퀀서·이벤트소싱·HA·ITCH/OUCH·오픈소스 엔진 비교) +
> 시장 무결성 리서치(STP·가격밴드·서킷브레이커·경매·감시). 웹 리서치 에이전트 2기 보고.
> 코드 검증: matching_engine ext4 빌드 성공(`~/supernoba-core-run/wrapper`), 결정론 감사 완료.

## 핵심 진단 (한 문장)

> 업계 정답은 **"상태를 저장·복원"이 아니라 "순번 붙은 입력을 저장·재생"**이다. 우리 Kinesis
> `supernoba-orders` 스트림은 이미 그 입력 저널인데 지금은 큐로 쓰고 버린다. **스냅샷에 시퀀스
> 번호를 붙이고 엔진의 결정론을 확보**하면 현재 최대 결함(10초 유실창 + 시간우선순위 소실)이
> 원리적으로 닫힌다. Liquibook 선택·단일스레드 매칭·게이트웨이 검증 위치는 업계 패턴과 일치(유지).

## 결정론 감사 결과 (실측)

리플레이 기반 복구를 막는 비결정 지점 — `system_clock::now()`로 시각을 찍음:
- `order.cpp:42` — timestamp 미제공 시 now() 폴백 (order-router가 보통 채우나 폴백이 비결정)
- `market_data_handler.cpp:101,308,372,398` — 체결·캔들 처리 시각
- `engine_core.cpp:234` — 스냅샷 시각(무해, 메타데이터)
→ **원칙: 매칭 결과에 영향을 주는 모든 시각은 입력 이벤트에서 와야 한다.** 체결 시각 = aggressor
  주문의 timestamp(입력값). now()는 로그·메타데이터에만.

---

## 계층별 배치 (무결성 리서치 §0 — 단일 장치 아닌 계층 중첩)

| 계층 | 시점 | 장치 | 컴포넌트 |
|---|---|---|---|
| ① 게이트웨이 | 접수 즉시(북 조회 X) | 틱/로트/notional·fat-finger·스로틀·잔고락 | order-router Lambda |
| ② 리스크 스테이지 | 매칭 직전(북 참조) | 가격밴드·post-only 교차·halt 검사 | engine addOrder 전단 |
| ③ 매칭 루프 | 상대 특정 순간 | **STP**·시장가 collar | engine_core.cpp |
| ④ 상태 머신 | 체결 기반(비동기) | VI 서킷브레이커·경매 전환 | market_data_handler + 상태 |
| ⑤ 사후 감시 | 체결 스트림 소비 | 워시/스푸핑/레이어링 탐지 | 별도 surveillance consumer |

---

## 공통 개선 (develop → 양 브랜치 전파) — 버스 무관 엔진 로직

### C1. STP (자전거래 방지) [구현 착수]
- 위치: `engine_core.cpp addOrder()`의 `book->add()` **직전**
- 정책: **cancel-oldest**(CME 기본) — aggressor limit까지 반대편 북에서 동일 user_id resting 주문을
  취소(on_cancel 발행 → 프로세서가 잔고 락 해제), aggressor는 계속 진행
- **MM 면제**: user_id가 mm- 계열이면 STP 스킵(MM은 의도적 자전체결) — restoreOrderBook의
  MM 판별 로직(286행) 재사용
- 회계: 방지 수량은 `filled_qty`와 분리(`prevented_qty`) — 안 그러면 잔고 락 영구 잔존
- 근거: 무결성 §1. 워시트레이딩 예방이 사후 탐지보다 압도적으로 저렴

### C2. 결정론 확보 [구현 착수]
- 체결/이벤트 시각을 aggressor 주문 timestamp에서 파생(now() 제거)
- order.cpp:42 폴백 제거 또는 명시적 결정론 소스로 대체
- 근거: 아키텍처 §2.2 — 리플레이 복구의 선행 조건

### C3. 주문 검증 필터 (엔진 측 최소 가드)
- 수량 0·음수 가격 등 게이트웨이 우회 경로(MM/어드민 직행) 방어용 최소 검증
- Binance filter 체계(무결성 §4) 참조. 주력은 order-router, 엔진은 백스톱
- 근거: 무결성 §7 순위 1 — 다른 모든 장치의 기반

### C4. 가격 밴드 + 시장가 collar
- 동적 밴드: 직전 체결가 ±Y%(엔진 진입부), 기준가 1% 히스테리시스 필수
- 시장가 collar: 반대편 최우선호가 ±Z%, 잔량은 경계가 지정가로 전환(취소 아님)
- **우선순위: halt 검사 > 밴드 검사**(무결성 §7 상호작용 3)

### C5. 종목별 VI 서킷브레이커 (KRX 단순형)
- 정적 VI: |last−prev_close|/prev_close ≥ 10% / 동적 VI: |last−prev_trade|/prev_trade ≥ 3~6%
- 발동 시 2분 단일가(AUCTION) → 단일가 체결 → CONTINUOUS 복귀
- 상태 전이를 **MM에 전파 필수**(mm:control) — 안 그러면 재개 단일가가 MM 호가로만 결정
- 판정=fill 콜백, 강제=addOrder 진입 검사, 전파=Valkey `symbol:{S}:state`

### C6. 신규 상장 opening auction
- C5 경매 코드 재사용 — 상장 시 AUCTION으로 시작, N분 주문수집 → 단일가 = 최초 prev
- 현재 신규종목 가격발견이 MM에 전적 의존하는 문제 해결

### C7. 종료 SEGV 수리 + order lifecycle 이벤트
- kinesis_consumer stop 실패 시 detach → join+배리어 (기존 todo Phase1)
- 감시용 order add/cancel/reject 이벤트 발행(스푸핑 탐지는 체결 아닌 취소 데이터 필요)

---

## AWS 인프라 버전 (infra/aws)

### A1. 스냅샷 시퀀스 앵커 (이벤트 소싱화) [최고 가치·저비용]
- Valkey 스냅샷 저장 시 **"Kinesis 시퀀스 번호 X까지 반영됨"**을 함께 기록
- 복구 = 스냅샷 로드 → **X 이후 Kinesis 레코드 리플레이** → 10초 유실창 소멸
- `CLEAR_CHECKPOINTS_ON_START=true`의 의미 재정의: 스냅샷+앵커가 있으면 앵커부터 재생
- 근거: 아키텍처 §2.4, §7.2①

### A2. 샤드 단일 정렬 보장
- 심볼별 파티션키로 한 심볼이 항상 한 샤드 → 결정론적 리플레이 성립(§2.1·§7.2③)
- 다중 샤드에 심볼이 걸쳐 있으면 전역 순서 없음 = 리플레이 불가

### A3. 지연 개선(선택·후순위): Enhanced Fan-Out(200ms→70ms). 신뢰성이 지연보다 우선
### A4. HA(필요 시): 리플리카가 같은 Kinesis 스트림 소비 → 웜 스탠바이(§3.2, 이벤트소싱의 부산물)
### A5. 배포: aws-application-prod(342843238598) OIDC, 정적 IAM 키 폐기

---

## 라즈베리파이 버전 (infra/raspi)

### R1. 입력 버스 = SQS FIFO (고정비 0 + ack 소비)
- Kinesis(샤드 시간당 과금) → SQS FIFO(롱폴링, 사실상 0원). MessageGroupId=심볼로 순서 보존
- 소비자: KinesisConsumer → SqsFifoConsumer. **처리 완료 시 삭제(ack), 실패 자동 재전달, DLQ 표준**
- 이것이 "다운타임 주문 블랙홀"을 **구조로** 해결(체크포인트 수정보다 우아)

### R2. 리플레이 앵커 = SQS는 로그가 아님 → 로컬 WAL이 진실 원천
- 입력을 로컬 append-only 저널(ext4)에 기록 + 시퀀스 → 스냅샷 앵커는 이 로컬 시퀀스
- 복구 = 스냅샷 + 로컬 WAL tail 재생 (LMAX Journaler 로컬판)

### R3. 로컬 스택: PostgreSQL·Valkey 4종 모두 파이 로컬. Secrets Manager→env 파일
### R4. 산출: 엔진↔프로세서 동일 기기 → Kinesis 구간 삭제(로컬 큐 직결)
### R5. 관리채널: gRPC 사설IP 평문 → 로컬 소켓/서명 큐. 인바운드 불요(전부 아웃바운드)
### R6. 가용성 한계 명시: 정전·인터넷 장애=거래 중단. 파이 5 8GB+ 권장(systemd 상한 합 5.5GB)

---

## 구현 순서 (의존성)

1. **C1 STP + C2 결정론** (버스 무관, 즉시 검증 가능) ← 지금 착수
2. C3 주문검증 백스톱
3. A1 시퀀스 앵커(AWS) ∥ R1 SQS 소비자(raspi) — 브랜치 분기
4. C4 가격밴드 → C5 VI → C6 경매 (상태머신, 침습적)
5. C7 + 감시 컨슈머

## 유지(바꾸지 않음)
- Liquibook 선택(컴포넌트 라이브러리로 정상 — 저널/복구/STP 미제공이 정의상 정상)
- 단일 스레드 매칭, 인메모리 오더북 + 이벤트 발행(DB 안 기다림)
- 주문입력/시세배포 분리(OUCH/ITCH 계보)
- 게이트웨이 프리트레이드 리스크 위치(단, MM 우회가 STP까지 우회하는지는 점검)
