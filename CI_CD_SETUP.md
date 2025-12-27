# CI/CD 설정 가이드

## 📋 개요

GitHub Actions를 사용한 자동 배포 파이프라인 설정 방법입니다.

---

## 🔧 필수 설정

### 1. GitHub Secrets 설정

GitHub Secrets는 세 가지 레벨에서 설정할 수 있습니다:

| 레벨 | 사용 시기 | 접근 방법 |
|------|----------|----------|
| **Repository** | 특정 저장소에만 적용 (권장) | Settings > Secrets and variables > Actions > New repository secret |
| **Organization** | 조직의 모든 저장소에 공유 | Organization Settings > Secrets and variables > Actions |
| **Environment** | 특정 환경(production, staging)에만 적용 | Repository Settings > Environments > [환경명] > Secrets |

**이 프로젝트의 경우: Repository secrets를 사용하세요.**

#### Repository Secrets 설정 방법

1. GitHub 저장소로 이동
2. **Settings** 탭 클릭
3. 왼쪽 메뉴에서 **Secrets and variables > Actions** 선택
4. **New repository secret** 버튼 클릭
5. 아래 secrets를 하나씩 추가:

**Lambda 배포용 Secrets:**
| Secret 이름 | 설명 | 예시 | 필수 |
|------------|------|------|------|
| `AWS_ACCESS_KEY_ID` | AWS 액세스 키 ID | `AKIAIOSFODNN7EXAMPLE` | ✅ |
| `AWS_SECRET_ACCESS_KEY` | AWS 시크릿 액세스 키 | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | ✅ |

**엔진 배포용 Secrets:**
| Secret 이름 | 설명 | 예시 | 필수 |
|------------|------|------|------|
| `EC2_SSH_KEY` | EC2 인스턴스 접속용 SSH private key (전체 내용) | `-----BEGIN RSA PRIVATE KEY-----...-----END RSA PRIVATE KEY-----` | ✅ |
| `EC2_HOSTS` | EC2 인스턴스 호스트명 또는 IP (쉼표로 구분, 여러 개 가능) | `ec2-1.compute.amazonaws.com,ec2-2.compute.amazonaws.com,ec2-3.compute.amazonaws.com` | ✅ |
| `EC2_USER` | EC2 사용자명 | `ec2-user` 또는 `ubuntu` | ✅ |
| `SLACK_WEBHOOK_URL` | Slack 알림용 Webhook URL (선택사항) | `https://hooks.slack.com/services/...` | ⚪ |

> **여러 인스턴스 배포:**
> - 여러 EC2 인스턴스가 있는 경우, `EC2_HOSTS`에 쉼표로 구분하여 모두 입력하세요
> - 예: `ec2-1.amazonaws.com,ec2-2.amazonaws.com,ec2-3.amazonaws.com`
> - 모든 인스턴스는 동일한 SSH 키(`EC2_SSH_KEY`)를 사용해야 합니다
> - 각 인스턴스에 순차적으로 배포됩니다

> **참고**: 
> - Repository secrets는 저장소의 모든 워크플로우에서 사용 가능합니다
> - Secrets는 암호화되어 저장되며, 값은 한 번 설정 후 다시 볼 수 없습니다
> - 수정하려면 기존 secret을 삭제하고 새로 생성해야 합니다

### 2. AWS 액세스 키 생성 (Lambda 배포용)

#### IAM 사용자 생성 및 키 발급

1. **AWS Console 접속**
   - https://console.aws.amazon.com/ 접속
   - 로그인

2. **IAM 서비스로 이동**
   - 검색창에 "IAM" 입력
   - IAM 서비스 선택

3. **사용자 생성**
   - 왼쪽 메뉴에서 **Users** 클릭
   - **Create user** 버튼 클릭
   - 사용자 이름 입력 (예: `github-actions-lambda-deploy`)
   - **Next** 클릭

4. **권한 설정**
   - **Attach policies directly** 선택
   - 다음 정책 추가:
     - `AWSLambda_FullAccess` (Lambda 함수 업데이트용)
     - 또는 최소 권한 정책 생성 (권장):
       ```json
       {
         "Version": "2012-10-17",
         "Statement": [
           {
             "Effect": "Allow",
             "Action": [
               "lambda:UpdateFunctionCode",
               "lambda:GetFunction",
               "lambda:GetFunctionConfiguration"
             ],
             "Resource": "arn:aws:lambda:ap-northeast-2:*:function:Supernoba-*"
           }
         ]
       }
       ```
   - **Next** 클릭

5. **사용자 생성 완료**
   - 검토 후 **Create user** 클릭

6. **액세스 키 생성**
   - 생성된 사용자 클릭
   - **Security credentials** 탭 클릭
   - **Create access key** 버튼 클릭
   - **Command Line Interface (CLI)** 선택
   - **Next** 클릭
   - 설명 추가 (선택사항, 예: "GitHub Actions Lambda Deploy")
   - **Create access key** 클릭

7. **키 정보 저장**
   - **Access key ID** 복사 → GitHub Secrets의 `AWS_ACCESS_KEY_ID`에 저장
   - **Secret access key** 복사 → GitHub Secrets의 `AWS_SECRET_ACCESS_KEY`에 저장
   - ⚠️ **주의**: Secret access key는 이 창을 닫으면 다시 볼 수 없습니다!

#### 최소 권한 정책 생성 (권장)

보안을 위해 최소 권한만 부여하는 것을 권장합니다:

1. **IAM > Policies > Create policy**
2. **JSON** 탭 선택
3. 다음 정책 입력:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "lambda:UpdateFunctionCode",
           "lambda:GetFunction",
           "lambda:GetFunctionConfiguration",
           "lambda:ListFunctions"
         ],
         "Resource": [
           "arn:aws:lambda:ap-northeast-2:*:function:Supernoba-*"
         ]
       }
     ]
   }
   ```
4. 정책 이름: `GitHubActionsLambdaDeploy`
5. **Create policy** 클릭
6. 사용자에 이 정책 연결

### 3. SSH 키 생성 및 설정 (엔진 배포용)

#### EC2에서 SSH 키 생성
```bash
# EC2 인스턴스에 접속
ssh -i your-key.pem ec2-user@your-ec2-instance

# GitHub Actions용 SSH 키 생성
ssh-keygen -t rsa -b 4096 -C "github-actions" -f ~/.ssh/github_actions
```

#### EC2에 공개키 등록
```bash
# 생성된 공개키를 authorized_keys에 추가
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

#### GitHub Secrets에 개인키 등록
```bash
# 로컬에서 개인키 내용 복사
cat ~/.ssh/github_actions

# GitHub Secrets > EC2_SSH_KEY에 전체 내용 붙여넣기
# (-----BEGIN RSA PRIVATE KEY----- 부터 -----END RSA PRIVATE KEY----- 까지)
```

---

## 🚀 워크플로우 사용 방법

### ✅ 자동 배포 활성화됨

워크플로우는 이미 자동 배포가 활성화되어 있습니다. 코드를 커밋하고 푸시하면 자동으로 배포됩니다!

**자동 배포가 작동하는 조건:**
- ✅ GitHub Secrets 설정 완료
- ✅ `main` 또는 `master` 브랜치에 푸시
- ✅ 변경된 파일 경로가 트리거 경로와 일치

**자세한 내용은 `AUTO_DEPLOY_GUIDE.md` 참고**

### 자동 배포 (Push 트리거)

#### Lambda 함수 배포
- `liquibook/lambda/**` 경로의 파일이 변경되면 자동으로 해당 Lambda 함수가 배포됩니다.
- 변경된 함수만 배포되므로 효율적입니다.

**예시:**
```bash
# Supernoba-admin Lambda 수정 후
git add liquibook/lambda/Supernoba-admin/index.mjs
git commit -m "Update admin Lambda"
git push origin main
# → 자동으로 Supernoba-admin만 배포됨
```

#### 엔진 배포
- `liquibook/wrapper/**` 또는 `liquibook/engine/**` 경로의 파일이 변경되면 자동으로 엔진이 배포됩니다.

**예시:**
```bash
# 엔진 코드 수정 후
git add liquibook/wrapper/src/main.cpp
git commit -m "Fix engine bug"
git push origin main
# → 자동으로 EC2에서 코드 업데이트, 빌드, 재시동 수행
```

### 수동 배포 (Workflow Dispatch)

#### Lambda 함수 수동 배포
1. GitHub 저장소의 **Actions** 탭으로 이동
2. **Deploy Lambda Functions** 워크플로우 선택
3. **Run workflow** 버튼 클릭
4. 옵션 설정:
   - **Branch**: 배포할 브랜치 선택
   - **Function name**: 특정 함수만 배포하려면 함수 이름 입력 (비워두면 모든 변경된 함수 배포)

#### 엔진 수동 배포
1. GitHub 저장소의 **Actions** 탭으로 이동
2. **Deploy Matching Engine** 워크플로우 선택
3. **Run workflow** 버튼 클릭
4. 옵션 설정:
   - **Branch**: 배포할 브랜치 선택
   - **Restart only**: 체크하면 코드 업데이트 없이 재시동만 수행

---

## 📊 워크플로우 상세

### deploy-lambda.yml

**트리거:**
- `liquibook/lambda/**` 경로 변경 시 자동 실행
- 수동 실행 가능

**동작:**
1. 변경된 Lambda 함수 감지
2. 각 함수별로 병렬 배포 (matrix strategy)
3. 의존성 설치 (`npm ci`)
4. 빌드 (esbuild 사용 함수의 경우)
5. ZIP 패키지 생성
6. AWS Lambda 업데이트
7. 배포 확인

**지원 함수:**
- Supernoba-admin
- Supernoba-order-router
- Supernoba-asset-handler
- Supernoba-fill-processor
- Supernoba-history-saver
- Supernoba-notifier
- Supernoba-chart-data-handler
- Supernoba-connect-handler
- Supernoba-subscribe-handler
- Supernoba-disconnect-handler

### deploy-engine.yml

**트리거:**
- `liquibook/wrapper/**` 또는 `liquibook/engine/**` 또는 `liquibook/aggregator/**` 경로 변경 시 자동 실행
- 수동 실행 가능

**동작:**
1. `EC2_HOSTS`에서 모든 호스트 파싱 (쉼표로 구분)
2. 각 EC2 인스턴스에 순차적으로:
   - SSH 접속
   - 코드 업데이트 (`git pull`) - `~/Liquibook` 또는 `~/liquibook` 경로 자동 감지
   - vcpkg 설치 및 의존성 설치 (필요한 경우)
   - 기존 프로세스 중지 (matching_engine, aggregator, streamer)
   - 빌드 (필요한 경우)
   - 엔진 재시동 (`--debug --dev` 옵션 기본 적용)
3. 모든 인스턴스에서 실행 확인
4. Slack 알림 발송 (설정된 경우)

**여러 인스턴스 지원:**
- `EC2_HOSTS`에 쉼표로 구분하여 여러 호스트 입력 가능
- 예: `ec2-1.amazonaws.com,ec2-2.amazonaws.com,ec2-3.amazonaws.com`
- 모든 인스턴스에 동일한 SSH 키 사용
- 각 인스턴스에 순차적으로 배포 (한 인스턴스 실패 시 중단)

---

## 🔍 배포 확인

### GitHub Actions에서 확인
1. **Actions** 탭에서 실행 중인 워크플로우 확인
2. 각 단계의 로그 확인
3. 성공/실패 상태 확인

### AWS Console에서 확인
1. **Lambda > Functions**에서 함수 상태 확인
2. **Code** 탭에서 배포된 코드 확인
3. **Monitoring** 탭에서 실행 로그 확인

### EC2에서 확인
```bash
# 엔진 프로세스 확인
ps aux | grep matching_engine

# 로그 확인
tail -f /tmp/engine.log
```

---

## ⚠️ 주의사항

1. **Secrets 보안**
   - Secrets는 절대 코드에 하드코딩하지 마세요
   - 정기적으로 키를 로테이션하세요

2. **배포 순서**
   - Lambda 배포는 독립적으로 수행 가능
   - 엔진 배포는 서비스 중단이 발생할 수 있으므로 주의

3. **롤백 방법**
   - Lambda: 이전 버전으로 수동 롤백 가능 (AWS Console)
   - 엔진: Git에서 이전 커밋으로 되돌린 후 재배포

4. **비용 관리**
   - GitHub Actions는 무료 플랜에서 월 2,000분 제공
   - 빌드 시간이 길면 비용이 발생할 수 있습니다

---

## 🐛 문제 해결

### Lambda 배포 실패
- **원인**: ZIP 파일 크기 초과 (50MB 제한)
- **해결**: 불필요한 의존성 제거 또는 Lambda Layer 사용

### 엔진 배포 실패
- **원인**: SSH 연결 실패
- **해결**: 
  - `EC2_SSH_KEY`와 `EC2_HOSTS` 확인
  - `EC2_HOSTS` 형식 확인 (쉼표로 구분, 공백 없이)
  - 각 호스트에 SSH 키가 등록되어 있는지 확인
  - 특정 호스트만 실패하는 경우, 해당 호스트의 SSH 연결 테스트

### Slack 알림 설정 (선택사항)

Slack에 배포 알림을 받으려면:

1. **Slack Webhook URL 생성**
   - Slack 워크스페이스 > Apps > Incoming Webhooks
   - "Add to Slack" 클릭
   - 알림을 받을 채널 선택
   - Webhook URL 복사

2. **GitHub Secrets에 추가**
   - Secret 이름: `SLACK_WEBHOOK_URL`
   - Value: 복사한 Webhook URL

3. **알림 내용**
   - 배포 성공/실패 상태
   - 배포된 브랜치 및 커밋
   - 배포된 인스턴스 수
   - 실패한 호스트 목록 (있는 경우)

### 빌드 실패
- **원인**: 의존성 문제 또는 컴파일 에러
- **해결**: 로컬에서 먼저 빌드 테스트

---

## 📚 참고 자료

- [GitHub Actions 문서](https://docs.github.com/en/actions)
- [AWS Lambda 배포 가이드](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-deploy.html)
- 프로젝트 내 문서:
  - `liquibook/DEPLOYMENT_GUIDE.md` - 배포 가이드
  - `liquibook/AWS_ARCHITECTURE.md` - 아키텍처 개요

