# API Gateway 현황 및 관리

AWS API Gateway 리소스 관리를 위한 문서입니다.

---

## 현재 API 구성 (2025-12-08 조회)

### WebSocket API

| 이름 | ID | 엔드포인트 | 용도 |
|------|-----|----------|------|
| `Supernoba-ws` | `l2ptm85wub` | `wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com` | 실시간 호가/체결 푸시 |

### REST API

| 이름 | ID | 생성일 | 용도 |
|------|-----|-------|------|
| `Supernoba-api` | `4xs6g4w8l6` | 2025-12-05 | 주문 라우팅 |
| `Supernoba-admin-API` | `0eeto6kblk` | 2025-12-07 | MSK 토픽 관리 |

---

## API 조회 명령어

```bash
# WebSocket API
aws apigatewayv2 get-apis --region ap-northeast-2 --no-cli-pager

# REST API
aws apigateway get-rest-apis --region ap-northeast-2 --no-cli-pager

# WebSocket 스테이지
aws apigatewayv2 get-stages --api-id l2ptm85wub --region ap-northeast-2 --no-cli-pager

# REST 스테이지
aws apigateway get-stages --rest-api-id 4xs6g4w8l6 --region ap-northeast-2 --no-cli-pager
```

---

## API 수정 CLI 가이드

### Lambda 통합 업데이트

```bash
# REST API Integration 수정
aws apigateway put-integration \
  --rest-api-id <api-id> \
  --resource-id <resource-id> \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-northeast-2:264520158196:function:order-router/invocations
```

### 스테이지 배포

```bash
aws apigateway create-deployment \
  --rest-api-id <api-id> \
  --stage-name prod \
  --region ap-northeast-2
```

### WebSocket 라우트 추가

```bash
aws apigatewayv2 create-route \
  --api-id <api-id> \
  --route-key "subscribe" \
  --target integrations/<integration-id>
```

---

## Kinesis 전환 시 API 변경사항

MSK → Kinesis 전환 시 API Gateway 자체는 변경 없음.
Lambda 함수 내부만 수정됨.

---

*최종 업데이트: 2025-12-08*
