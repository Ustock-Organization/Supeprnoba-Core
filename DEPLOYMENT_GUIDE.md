# 백엔드 배포 가이드

## 📋 수정 완료 사항

### S3 백업 관련 코드 삭제
- ✅ `Supernoba-admin` Lambda: S3Client import 및 초기화 제거
- ✅ `Supernoba-admin` package.json: `@aws-sdk/client-s3` 의존성 제거
- ✅ `admin_config.json`: `S3_BUCKET` 환경 변수 제거
- ✅ 문서 업데이트: README, AWS_ARCHITECTURE.md, generate_architecture.py

### 배포 완료
- ✅ `Supernoba-admin` Lambda 배포 완료 (2025-12-27)
  - FunctionArn: `arn:aws:lambda:ap-northeast-2:264520158196:function:Supernoba-admin`
  - CodeSize: 10.9 MB
  - LastModified: 2025-12-27T16:04:06.000+0000

### CI/CD 구축 완료
- ✅ GitHub Actions 워크플로우 생성
  - `.github/workflows/deploy-lambda.yml` - Lambda 자동 배포
  - `.github/workflows/deploy-engine.yml` - 엔진 자동 배포

---

## 🚀 Lambda 함수 배포

### 수정된 Lambda 함수
다음 Lambda 함수가 수정되었으므로 재배포가 필요합니다:
- **Supernoba-admin** (S3 관련 코드 제거)

### 배포 방법

#### 방법 1: AWS CLI 사용 (권장)

```bash
# 1. Lambda 함수 디렉토리로 이동
cd liquibook/lambda/Supernoba-admin

# 2. 의존성 설치 (package.json 변경사항 반영)
npm install

# 3. ZIP 파일 생성
zip -r function.zip index.mjs node_modules/ package.json

# 4. Lambda 함수 업데이트
aws lambda update-function-code \
  --function-name Supernoba-admin \
  --zip-file fileb://function.zip \
  --region ap-northeast-2

# 5. 배포 확인
aws lambda get-function --function-name Supernoba-admin --region ap-northeast-2
```

#### 방법 2: Node.js 스크립트 사용 (Windows)

```bash
# 1. Lambda 함수 디렉토리로 이동
cd liquibook/lambda/Supernoba-admin

# 2. 의존성 설치
npm install

# 3. ZIP 파일 생성
# Windows PowerShell:
Compress-Archive -Path index.mjs,node_modules,package.json -DestinationPath function.zip

# 4. AWS CLI로 업로드
aws lambda update-function-code --function-name Supernoba-admin --zip-file fileb://function.zip --region ap-northeast-2
```

#### 방법 3: esbuild 사용 (order-router 스타일)

일부 Lambda는 esbuild를 사용합니다:

```bash
# 예: Supernoba-order-router
cd liquibook/lambda/Supernoba-order-router
node build.js
cd dist
zip -r function.zip index.js
aws lambda update-function-code --function-name Supernoba-order-router --zip-file fileb://function.zip
```

---

## 🔄 매칭 엔진 재시동

### EC2에서 엔진 재시동

#### 1. SSH 접속
```bash
ssh -i your-key.pem ec2-user@your-ec2-instance
```

#### 2. 엔진 프로세스 확인
```bash
# 실행 중인 엔진 프로세스 확인
ps aux | grep matching_engine

# 또는 systemd 서비스로 실행 중인 경우
sudo systemctl status matching-engine
```

#### 3. 엔진 중지
```bash
# 프로세스 직접 실행 중인 경우
pkill -f matching_engine

# systemd 서비스인 경우
sudo systemctl stop matching-engine
```

#### 4. 코드 업데이트 (필요시)
```bash
cd ~/liquibook
git pull origin main  # 또는 해당 브랜치
```

#### 5. 엔진 재시동
```bash
cd ~/liquibook/wrapper
./run_engine.sh

# 또는 디버그 모드로 실행
./run_engine.sh --debug

# 또는 개발 모드 (캐시 초기화 후 시작)
./run_engine.sh --dev
```

#### 6. 실행 확인
```bash
# 로그 확인
tail -f /var/log/matching-engine.log

# 또는 프로세스 확인
ps aux | grep matching_engine
```

---

## 🔧 CI/CD 절차

### ✅ CI/CD 워크플로우 구축 완료

GitHub Actions를 사용한 자동 배포 파이프라인이 구축되었습니다.

#### 생성된 워크플로우 파일
- `.github/workflows/deploy-lambda.yml` - Lambda 함수 자동 배포
- `.github/workflows/deploy-engine.yml` - 매칭 엔진 자동 배포

### CI/CD 설정 방법

#### 1. GitHub Secrets 설정

GitHub 저장소의 Settings > Secrets and variables > Actions에서 다음 secrets를 추가하세요:

**Lambda 배포용:**
- `AWS_ACCESS_KEY_ID` - AWS 액세스 키 ID
- `AWS_SECRET_ACCESS_KEY` - AWS 시크릿 액세스 키

**엔진 배포용:**
- `EC2_SSH_KEY` - EC2 인스턴스 접속용 SSH private key
- `EC2_HOST` - EC2 인스턴스 호스트명 또는 IP
- `EC2_USER` - EC2 사용자명 (일반적으로 `ec2-user` 또는 `ubuntu`)

#### 2. 워크플로우 동작 방식

**Lambda 배포 (`deploy-lambda.yml`):**
- `liquibook/lambda/**` 경로의 파일이 변경되면 자동 트리거
- 변경된 Lambda 함수만 자동으로 배포
- 수동 실행 시 특정 함수만 선택 배포 가능

**엔진 배포 (`deploy-engine.yml`):**
- `liquibook/wrapper/**` 또는 `liquibook/engine/**` 경로의 파일이 변경되면 자동 트리거
- EC2에서 코드 업데이트, 빌드, 재시동 자동 수행
- 수동 실행 시 재시동만 수행 가능 (코드 업데이트 스킵)

#### 3. 수동 실행 방법

GitHub Actions 탭에서:
1. "Deploy Lambda Functions" 또는 "Deploy Matching Engine" 워크플로우 선택
2. "Run workflow" 버튼 클릭
3. 필요시 옵션 설정 (예: 특정 Lambda 함수만 배포)

### 권장 CI/CD 워크플로우 (레거시 - 참고용)

#### 1. Git 워크플로우
```bash
# 1. 변경사항 커밋
git add .
git commit -m "Remove S3 backup code from backend"

# 2. 원격 저장소에 푸시
git push origin main

# 3. EC2에서 pull
ssh ec2-user@ec2-instance
cd ~/liquibook
git pull origin main
```

#### 2. Lambda 배포 자동화 (권장)

`.github/workflows/deploy-lambda.yml` 생성:

```yaml
name: Deploy Lambda Functions

on:
  push:
    branches: [main]
    paths:
      - 'liquibook/lambda/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ap-northeast-2
      
      - name: Deploy Supernoba-admin
        working-directory: liquibook/lambda/Supernoba-admin
        run: |
          npm install
          zip -r function.zip index.mjs node_modules/ package.json
          aws lambda update-function-code \
            --function-name Supernoba-admin \
            --zip-file fileb://function.zip
```

#### 3. 엔진 배포 자동화 (권장)

`.github/workflows/deploy-engine.yml` 생성:

```yaml
name: Deploy Matching Engine

on:
  push:
    branches: [main]
    paths:
      - 'liquibook/wrapper/**'
      - 'liquibook/engine/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Configure SSH
        uses: webfactory/ssh-agent@v0.7.0
        with:
          ssh-private-key: ${{ secrets.EC2_SSH_KEY }}
      
      - name: Deploy to EC2
        run: |
          ssh -o StrictHostKeyChecking=no ec2-user@${{ secrets.EC2_HOST }} << 'EOF'
            cd ~/liquibook
            git pull origin main
            cd wrapper
            pkill -f matching_engine || true
            ./run_engine.sh
          EOF
```

### 수동 배포 체크리스트

#### Lambda 배포 전
- [ ] 코드 변경사항 커밋 및 푸시
- [ ] `package.json` 의존성 확인
- [ ] 로컬에서 테스트 (가능한 경우)
- [ ] ZIP 파일 생성 및 검증

#### Lambda 배포 후
- [ ] AWS Console에서 함수 상태 확인
- [ ] 테스트 이벤트로 함수 실행 확인
- [ ] CloudWatch Logs에서 에러 확인

#### 엔진 재시동 전
- [ ] 코드 변경사항 커밋 및 푸시
- [ ] EC2에서 최신 코드 pull
- [ ] 실행 중인 엔진 프로세스 확인

#### 엔진 재시동 후
- [ ] 프로세스 실행 상태 확인
- [ ] 로그에서 에러 확인
- [ ] Kinesis 연결 확인
- [ ] Valkey 연결 확인
- [ ] 주문 처리 테스트

---

## 📝 배포 명령어 요약

### Lambda 배포 (Supernoba-admin)
```bash
cd liquibook/lambda/Supernoba-admin
npm install
zip -r function.zip index.mjs node_modules/ package.json
aws lambda update-function-code --function-name Supernoba-admin --zip-file fileb://function.zip --region ap-northeast-2
```

### 엔진 재시동
```bash
# EC2에서 실행
cd ~/liquibook/wrapper
pkill -f matching_engine
./run_engine.sh
```

---

## ⚠️ 주의사항

1. **Lambda 배포 시**
   - ZIP 파일 크기 제한: 50MB (압축 전), 250MB (압축 후)
   - 배포 후 함수가 자동으로 재시작됩니다
   - 환경 변수는 별도로 업데이트해야 합니다

2. **엔진 재시동 시**
   - 실행 중인 주문 처리가 중단될 수 있습니다
   - 재시동 전에 현재 상태를 확인하세요
   - `--dev` 모드는 캐시를 초기화하므로 주의하세요

3. **배포 순서**
   - Lambda 배포 → 엔진 재시동 순서 권장
   - 또는 엔진 재시동 → Lambda 배포 (상황에 따라)

---

## 🔍 배포 확인

### Lambda 함수 확인
```bash
# 함수 상태 확인
aws lambda get-function --function-name Supernoba-admin --region ap-northeast-2

# 최근 실행 로그 확인
aws logs tail /aws/lambda/Supernoba-admin --follow --region ap-northeast-2
```

### 엔진 확인
```bash
# 프로세스 확인
ps aux | grep matching_engine

# 로그 확인 (로그 파일 경로에 따라)
tail -f /var/log/matching-engine.log
# 또는
journalctl -u matching-engine -f
```

---

## 📚 참고 자료

- [AWS Lambda 배포 가이드](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-deploy.html)
- [EC2 인스턴스 관리](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)
- 프로젝트 내 문서:
  - `liquibook/AWS_ARCHITECTURE.md` - 아키텍처 개요
  - `liquibook/wrapper/run_engine.sh` - 엔진 실행 스크립트
