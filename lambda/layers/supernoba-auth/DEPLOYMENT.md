# Supernoba Auth Layer 배포 가이드

## 개요

이 Lambda Layer는 Supabase JWT 토큰을 검증하여 API 요청을 인증합니다.

## 파일 구조

```
layers/supernoba-auth/
  nodejs/
    verifyAuth.mjs      # 인증 로직
    package.json        # 패키지 정의
  deploy-layer.ps1      # 배포 스크립트
  DEPLOYMENT.md         # 이 문서
```

## 배포 단계

### 1. Lambda Layer 배포

```powershell
cd C:\develop\liquibook\lambda\layers\supernoba-auth
.\deploy-layer.ps1
```

또는 수동 배포:

```bash
cd C:\develop\liquibook\lambda\layers\supernoba-auth

# 압축
powershell Compress-Archive -Path nodejs -DestinationPath supernoba-auth-layer.zip -Force

# 배포
aws lambda publish-layer-version \
  --layer-name supernoba-auth \
  --description "Supernoba Auth Layer - JWT verification" \
  --zip-file fileb://supernoba-auth-layer.zip \
  --compatible-runtimes nodejs18.x nodejs20.x \
  --region ap-northeast-2
```

### 2. Lambda 함수에 Layer 추가

배포 후 출력된 Layer ARN을 사용하여 각 Lambda 함수에 추가:

```bash
# order-router
aws lambda update-function-configuration \
  --function-name Supernoba-order-router \
  --layers arn:aws:lambda:ap-northeast-2:ACCOUNT_ID:layer:supernoba-auth:VERSION

# admin
aws lambda update-function-configuration \
  --function-name Supernoba-admin \
  --layers arn:aws:lambda:ap-northeast-2:ACCOUNT_ID:layer:supernoba-auth:VERSION

# admin-mm
aws lambda update-function-configuration \
  --function-name Supernoba-admin-mm \
  --layers arn:aws:lambda:ap-northeast-2:ACCOUNT_ID:layer:supernoba-auth:VERSION
```

### 3. 환경변수 설정

각 Lambda 함수에 다음 환경변수 추가:

```bash
SUPABASE_JWT_SECRET=<your-supabase-jwt-secret>
```

Supabase JWT Secret은 Supabase Dashboard에서 확인:
- Project Settings > API > JWT Secret

### 4. Lambda 코드 업데이트

각 Lambda 함수의 index.mjs를 index-with-auth.mjs로 교체:

```bash
# order-router
cd C:\develop\liquibook\lambda\Supernoba-order-router
copy index-with-auth.mjs index.mjs

# admin
cd C:\develop\liquibook\lambda\Supernoba-admin
copy index-with-auth.mjs index.mjs

# admin-mm
cd C:\develop\liquibook\lambda\Supernoba-admin-mm
copy index-with-auth.mjs index.mjs
```

그 후 각 Lambda를 재배포합니다.

## 인증 방식

### 1. 일반 사용자 (order-router)

- Supabase에서 발급된 JWT 토큰 필요
- `Authorization: Bearer <token>` 헤더로 전달
- 토큰의 `sub` (user_id)와 요청의 `user_id` 일치 필요

### 2. 관리자 (admin, admin-mm)

두 가지 방식 지원 (하위 호환성):

**방식 1: 기존 API 키**
```
Authorization: <ADMIN_API_KEY>
```

**방식 2: JWT 토큰**
```
Authorization: Bearer <admin-jwt-token>
```

관리자 확인 기준:
- JWT의 `role`이 `admin` 또는 `service_role`
- 이메일이 `admin@supernoba.com` 또는 `tchinnom@gmail.com`
- JWT의 `app_metadata.is_admin` 또는 `user_metadata.is_admin`이 `true`

## 제공 함수

### verifyAuth(event, options)

일반 JWT 검증

```javascript
const result = await verifyAuth(event);
if (!result.success) {
  return authErrorResponse(result);
}
console.log(result.userId, result.email);
```

Options:
- `required`: 인증 필수 여부 (기본: true)
- `allowedRoles`: 허용된 역할 배열

### verifyAdmin(event, options)

관리자 전용 검증 (API 키 + JWT)

```javascript
const result = await verifyAdmin(event);
if (!result.success) {
  return authErrorResponse(result);
}
console.log(result.method); // 'api_key' or 'jwt'
```

### verifySelf(event, resourceUserId)

사용자 본인 확인

```javascript
const result = await verifySelf(event, order.user_id);
if (!result.success) {
  return authErrorResponse(result);
}
```

### authErrorResponse(result, headers)

인증 실패 응답 생성

## 에러 코드

| 코드 | 상태 | 설명 |
|------|------|------|
| NO_TOKEN | 401 | Authorization 헤더 없음 |
| EMPTY_TOKEN | 401 | 빈 토큰 |
| INVALID_TOKEN | 401 | 잘못된 토큰 형식/서명 |
| TOKEN_EXPIRED | 401 | 만료된 토큰 |
| FORBIDDEN | 403 | 권한 없음 |
| CONFIG_ERROR | 500 | 서버 설정 오류 |

## 테스트

Layer 없이 로컬 테스트 시, 인증은 자동으로 스킵됩니다 (개발 모드).

프로덕션에서는 반드시 Layer를 연결하고 SUPABASE_JWT_SECRET을 설정해야 합니다.
