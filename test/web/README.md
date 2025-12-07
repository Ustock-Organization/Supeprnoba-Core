# Supernoba API Test Console

매칭 엔진 및 WebSocket API를 테스트하기 위한 웹 콘솔입니다.

## 사용 방법

### 1. 로컬 실행

```bash
cd test/web
# 간단한 HTTP 서버 실행
python -m http.server 8080
# 또는
npx serve .
```

브라우저에서 `http://localhost:8080` 접속

### 2. 기능

| 기능 | 설명 |
|------|------|
| **WebSocket 연결** | API Gateway WebSocket 연결/해제 |
| **심볼 구독** | AAPL, GOOGL 등 심볼 구독 |
| **주문 제출** | 매수/매도 주문 API 호출 |
| **호가창** | 실시간 호가 업데이트 표시 |
| **MSK Admin** | 토픽 목록/생성/상세 조회 |
| **메시지 로그** | 모든 WebSocket 메시지 로깅 |

### 3. 설정

테스트 전 다음 엔드포인트 입력 필요:

- **WebSocket**: `wss://xxx.execute-api.ap-northeast-2.amazonaws.com/prod`
- **Order API**: `https://xxx.execute-api.ap-northeast-2.amazonaws.com/orders`
- **Admin API**: `https://xxx.execute-api.ap-northeast-2.amazonaws.com/admin`

---

*최종 업데이트: 2025-12-07*
