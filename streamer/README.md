# Streamer - C++ WebSocket 실시간 스트리머

EC2에서 상주 프로세스로 실행되어 Redis 호가 캐시를 WebSocket 클라이언트에게 직접 전송합니다.

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
