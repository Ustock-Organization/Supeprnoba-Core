# Streamer - WebSocket 실시간 스트리머

> ⚠️ **정본은 Node.js 버전(`node/index.mjs`)이다.** systemd 유닛(`deploy/systemd/supernoba-streamer.service`)과
> 배포 스크립트가 전부 `streamer/node`를 가리키며, 이 디렉토리의 C++ 구현(`src/`, `CMakeLists.txt`)은
> 어떤 배포 경로에서도 빌드되지 않는 **죽은 코드**다 (2026-08-12 실사).

EC2에서 상주 프로세스로 실행되어 Valkey 호가 캐시를 폴링(50ms)해 API Gateway Management API로
WebSocket 클라이언트에게 전송합니다.

## 빌드

```bash
mkdir build && cd build
cmake ..
make
```

## 실행

```bash
./streamer --redis-host=<valkey-endpoint> --ws-port=8080
```

## 아키텍처

```
[C++ Engine] → [Valkey 캐시] → [Streamer] → [WebSocket 클라이언트]
                  depth:AAPL        ↑
                                    └── 지속 폴링 (ms 단위)
```
