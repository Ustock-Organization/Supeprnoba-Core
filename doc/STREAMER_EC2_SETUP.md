# Streaming Server EC2 배포 가이드

## 스크립트 차이점

| 스크립트 | 위치 | 용도 |
|---------|------|------|
| `wrapper/run_engine.sh` | `~/liquibook/wrapper/` | **매칭 엔진 전용** - Git pull, 빌드, 실행 자동화. 환경변수 하드코딩. |
| `engine_start.sh` | `~/liquibook/` | **통합 관리** - 엔진 + 스트리머 동시 실행 가능. `.env` 파일 지원. |

**권장**: 기존대로 `wrapper/run_engine.sh --kinesis` 사용 (더 상세한 설정)

---

## 별도 EC2 인스턴스 구성 (Streaming Server)

### 1. AWS 콘솔 설정

#### EC2 인스턴스 생성
```
인스턴스 이름: supernoba-streamer
AMI: Amazon Linux 2023
인스턴스 유형: t3.small (충분)
키 페어: 기존 키 사용
```

#### VPC/보안 그룹 설정
```
VPC: 기존 supernoba-xxx VPC 사용 (Valkey 접근 필요)
서브넷: private-1a 또는 private-1c
보안 그룹 인바운드:
  - SSH (22): My IP
  - TCP (없음 - 아웃바운드만 사용)
보안 그룹 아웃바운드:
  - HTTPS (443): 0.0.0.0/0 (API Gateway)
  - TCP (6379): Valkey 보안그룹 ID
```

#### IAM 역할
```
역할 이름: StreamerEC2Role
정책:
  - AmazonAPIGatewayInvokeFullAccess
  - AmazonElastiCacheReadOnlyAccess
```

---

### 2. EC2 초기 설정

```bash
# SSH 접속
ssh -i your-key.pem ec2-user@<streamer-ip>

# 시스템 업데이트
sudo dnf update -y

# Node.js 설치 (v20 LTS)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

# Git 설치
sudo dnf install -y git

# 버전 확인
node -v   # v20.x.x
npm -v    # 10.x.x
git --version
```

---

### 3. 코드 배포

```bash
# 홈 디렉토리
cd ~

# 리포지토리 클론
git clone https://github.com/<your-org>/liquibook.git
cd liquibook

# 브랜치 체크아웃
git checkout develop

# 스트리머 디렉토리 이동
cd streamer/node

# 의존성 설치
npm install
```

---

### 4. 환경변수 설정

```bash
# ~/.bashrc에 추가
cat >> ~/.bashrc << 'EOF'

# Streamer 환경변수
export VALKEY_HOST="master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com"
export VALKEY_PORT="6379"
export WEBSOCKET_ENDPOINT="xxxxxxxxxx.execute-api.ap-northeast-2.amazonaws.com/production"
export AWS_REGION="ap-northeast-2"
EOF

# 적용
source ~/.bashrc

# 확인
echo $VALKEY_HOST
echo $WEBSOCKET_ENDPOINT
```

---

### 5. 스트리머 실행

```bash
cd ~/liquibook/streamer/node

# 환경변수 수정 (필요시)
vi run_streamer.sh

# 실행 권한 부여
chmod +x run_streamer.sh

# 테스트 실행 (포그라운드)
./run_streamer.sh

# PM2로 백그라운드 실행 (권장)
sudo npm install -g pm2
pm2 start run_streamer.sh --name streamer
pm2 save
pm2 startup  # 시스템 시작 시 자동 실행
```

---

### 6. 모니터링

```bash
# 로그 확인
pm2 logs streamer

# 상태 확인
pm2 status

# 재시작
pm2 restart streamer
```

---

## Auto Scaling 설정 (추후)

```
Launch Template: streamer-template
  - AMI: 위에서 설정한 인스턴스 이미지화
  - User Data: 자동 시작 스크립트
  
Auto Scaling Group:
  - Min: 1, Max: 3
  - Target Tracking: CPU 70%
```

---

## 아키텍처 다이어그램

```
┌─────────────────┐      ┌──────────────────┐
│  EC2 #1         │      │  EC2 #2          │
│  (Engine)       │      │  (Streamer)      │
│                 │      │                  │
│  matching_engine│──────▶  node index.mjs  │
│        │        │ Valkey│        │        │
│        ▼        │      │        ▼        │
│   depth:SYMBOL  │◀─────│   읽기 (500ms)   │
│   (Redis SET)   │      │        │        │
└─────────────────┘      │        ▼        │
                         │  API Gateway     │
                         │  PostToConnection│
                         └────────┬─────────┘
                                  │
                                  ▼
                           WebSocket 클라이언트
```
