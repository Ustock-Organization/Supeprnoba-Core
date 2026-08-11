# 자동 배포 가이드

## 🚀 자동 배포 작동 방법

### 현재 설정 상태

워크플로우가 이미 설정되어 있으며, 다음 조건에서 **자동으로 실행**됩니다:

#### Lambda 함수 자동 배포
- **트리거**: `liquibook/lambda/**` 경로의 파일이 변경되고 `main` 또는 `master` 브랜치에 푸시될 때
- **파일**: `.github/workflows/deploy-lambda.yml`

#### 엔진 자동 배포
- **트리거**: 다음 경로의 파일이 변경되고 `main` 또는 `master` 브랜치에 푸시될 때:
  - `liquibook/wrapper/**`
  - `liquibook/engine/**`
  - `liquibook/aggregator/**`
- **파일**: `.github/workflows/deploy-engine.yml`

---

## ✅ 자동 배포를 위한 필수 확인 사항

### 1. GitHub Secrets 설정 확인

다음 secrets가 모두 설정되어 있는지 확인하세요:

**필수 Secrets:**
- ✅ `AWS_ACCESS_KEY_ID` - Lambda 배포용
- ✅ `AWS_SECRET_ACCESS_KEY` - Lambda 배포용
- ✅ `EC2_SSH_KEY` - 엔진 배포용
- ✅ `EC2_HOSTS` - 엔진 배포용 (쉼표로 구분)
- ✅ `EC2_USER` - 엔진 배포용

**선택 Secrets:**
- ⚪ `SLACK_WEBHOOK_URL` - Slack 알림용 (선택사항)

**확인 방법:**
1. GitHub 저장소 > **Settings** > **Secrets and variables** > **Actions**
2. 위의 secrets가 모두 있는지 확인

### 2. 워크플로우 파일 위치 확인

다음 파일들이 올바른 위치에 있는지 확인:
- `.github/workflows/deploy-lambda.yml`
- `.github/workflows/deploy-engine.yml`

**확인 방법:**
```bash
ls -la .github/workflows/
```

### 3. 브랜치 이름 확인

워크플로우는 `main` 또는 `master` 브랜치에만 자동 실행됩니다.

**현재 브랜치 확인:**
```bash
git branch
```

**브랜치 이름이 다른 경우:**
- 워크플로우 파일의 `branches: [main, master]` 부분에 브랜치 이름 추가
- 또는 해당 브랜치로 이름 변경

---

## 🔄 자동 배포 테스트 방법

### 방법 1: 실제 코드 변경으로 테스트

#### Lambda 배포 테스트
```bash
# 1. Lambda 함수 코드 수정
cd liquibook/lambda/Supernoba-admin
# index.mjs 파일에 주석 한 줄 추가하거나 수정

# 2. 커밋 및 푸시
git add liquibook/lambda/Supernoba-admin/index.mjs
git commit -m "Test: Lambda auto-deploy"
git push origin main

# 3. GitHub Actions에서 확인
# GitHub 저장소 > Actions 탭에서 워크플로우 실행 확인
```

#### 엔진 배포 테스트
```bash
# 1. 엔진 코드 수정
cd liquibook/wrapper
# src/main.cpp 파일에 주석 한 줄 추가하거나 수정

# 2. 커밋 및 푸시
git add liquibook/wrapper/src/main.cpp
git commit -m "Test: Engine auto-deploy"
git push origin main

# 3. GitHub Actions에서 확인
# GitHub 저장소 > Actions 탭에서 워크플로우 실행 확인
```

### 방법 2: 수동 실행으로 테스트

워크플로우가 제대로 설정되어 있는지 먼저 수동 실행으로 테스트:

1. **GitHub 저장소** > **Actions** 탭 이동
2. **Deploy Lambda Functions** 또는 **Deploy Matching Engine** 선택
3. **Run workflow** 버튼 클릭
4. 브랜치 선택 후 **Run workflow** 클릭
5. 실행 로그 확인

---

## 📋 자동 배포 체크리스트

배포 전 확인:

- [ ] GitHub Secrets 모두 설정됨
- [ ] 워크플로우 파일이 `.github/workflows/` 디렉토리에 있음
- [ ] 현재 브랜치가 `main` 또는 `master`임
- [ ] 변경된 파일 경로가 워크플로우 트리거 경로와 일치함
- [ ] 코드 변경사항이 커밋되어 있음

---

## 🔍 자동 배포 확인 방법

### GitHub Actions에서 확인

1. **GitHub 저장소** > **Actions** 탭
2. 최근 실행된 워크플로우 확인
3. 각 단계의 로그 확인
4. 성공/실패 상태 확인

### 배포 성공 확인

#### Lambda 배포
```bash
# AWS CLI로 확인
aws lambda get-function --function-name Supernoba-admin --region ap-northeast-2 --query 'Configuration.LastModified'
```

#### 엔진 배포
```bash
# EC2에 SSH 접속하여 확인
ssh -i your-key.pem ec2-user@your-ec2-instance
ps aux | grep matching_engine
tail -f /tmp/engine.log
```

---

## 🐛 자동 배포가 작동하지 않는 경우

### 문제 1: 워크플로우가 실행되지 않음

**원인:**
- 변경된 파일 경로가 트리거 경로와 일치하지 않음
- 브랜치 이름이 `main` 또는 `master`가 아님
- 워크플로우 파일이 올바른 위치에 없음

**해결:**
1. 변경된 파일 경로 확인
2. 브랜치 이름 확인
3. `.github/workflows/` 디렉토리 확인

### 문제 2: Secrets 오류

**원인:**
- Secrets가 설정되지 않음
- Secret 이름이 정확하지 않음

**해결:**
1. GitHub Settings > Secrets 확인
2. Secret 이름이 정확한지 확인 (대소문자 구분)

### 문제 3: SSH 연결 실패

**원인:**
- `EC2_SSH_KEY` 형식 오류
- `EC2_HOSTS` 형식 오류
- EC2 인스턴스에 SSH 키가 등록되지 않음

**해결:**
1. SSH 키 형식 확인 (전체 내용, 줄바꿈 포함)
2. `EC2_HOSTS` 형식 확인 (쉼표로 구분, 공백 없이)
3. EC2 인스턴스에서 SSH 키 등록 확인

---

## 📝 자동 배포 예시

### 예시 1: Lambda 함수 수정 후 자동 배포

```bash
# 1. 코드 수정
vim liquibook/lambda/Supernoba-admin/index.mjs
# (코드 수정)

# 2. 커밋 및 푸시
git add liquibook/lambda/Supernoba-admin/index.mjs
git commit -m "Fix: Update admin Lambda logic"
git push origin main

# 3. 자동 배포 시작
# → GitHub Actions가 자동으로 감지하여 배포 시작
# → Actions 탭에서 진행 상황 확인
```

### 예시 2: 엔진 코드 수정 후 자동 배포

```bash
# 1. 코드 수정
vim liquibook/wrapper/src/main.cpp
# (코드 수정)

# 2. 커밋 및 푸시
git add liquibook/wrapper/src/main.cpp
git commit -m "Fix: Update engine logic"
git push origin main

# 3. 자동 배포 시작
# → GitHub Actions가 자동으로 감지하여 배포 시작
# → 모든 EC2 인스턴스에 순차적으로 배포
# → Slack 알림 발송 (설정된 경우)
```

---

## ⚙️ 자동 배포 비활성화 방법

자동 배포를 일시적으로 비활성화하려면:

### 방법 1: 워크플로우 파일 임시 이름 변경
```bash
mv .github/workflows/deploy-engine.yml .github/workflows/deploy-engine.yml.disabled
```

### 방법 2: 브랜치 보호 규칙 사용
- GitHub Settings > Branches > Branch protection rules
- 특정 브랜치에 대한 자동 배포 제한

---

## 🎯 요약

**자동 배포가 작동하려면:**

1. ✅ GitHub Secrets 설정 완료
2. ✅ 워크플로우 파일이 `.github/workflows/`에 있음
3. ✅ `main` 또는 `master` 브랜치에 푸시
4. ✅ 변경된 파일 경로가 트리거 경로와 일치

**자동 배포 테스트:**
```bash
# 간단한 변경사항 커밋 및 푸시
git add .
git commit -m "Test: Auto-deploy"
git push origin main
```

그러면 GitHub Actions가 자동으로 배포를 시작합니다! 🚀

