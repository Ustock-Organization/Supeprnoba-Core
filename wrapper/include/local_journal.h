#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

namespace aws_wrapper {

/**
 * LocalJournal — 라즈베리파이 버전의 입력 저널(WAL).
 *
 * 배경: AWS 버전은 Kinesis 스트림 자체가 순번 붙은 입력 저널이라 리플레이 복구가 가능하다.
 * 그러나 라즈베리파이 버전은 입력 버스가 SQS FIFO(ack 시 메시지 삭제 — 로그가 아님)이거나
 * 로컬 큐이므로, 리플레이할 durable 로그가 없다. LocalJournal이 그 역할을 대신한다:
 * 소비한 모든 주문 이벤트를 로컬 append-only 파일(ext4)에 단조 증가 시퀀스와 함께 기록하고,
 * 복구 시 스냅샷 앵커 이후의 tail을 재생한다. (LMAX Journaler의 로컬 등가물)
 *
 * 파일 포맷(바이너리 안전, 길이 프리픽스):
 *   각 레코드 = 헤더라인 "<seq> <keylen> <vallen>\n" 뒤에 key 바이트, value 바이트, '\n'
 *   → key/value에 개행·탭이 있어도 안전.
 *
 * 내구성: POSIX write + (옵션) fsync로 전원 손실에도 커밋된 레코드를 보존.
 * 스레드 안전: append는 mutex로 직렬화(단일 소비자 스레드 전제이나 방어적).
 */
class LocalJournal {
public:
    using ReplayCallback = std::function<void(uint64_t seq,
                                              const std::string& key,
                                              const std::string& value)>;

    // path: 저널 파일 경로(ext4 권장). fsync_each: 매 append마다 fsync(내구성 우선).
    explicit LocalJournal(const std::string& path, bool fsync_each = true);
    ~LocalJournal();

    // 저널 오픈. 기존 파일이 있으면 마지막 유효 시퀀스를 복원해 이어쓴다.
    bool open();

    // 이벤트를 저널에 추가하고 할당된 시퀀스를 반환(0 = 실패).
    uint64_t append(const std::string& key, const std::string& value);

    // after_seq 초과 시퀀스의 레코드를 순서대로 콜백에 전달.
    // 반환: 재생한 레코드 수. 손상/부분 기록 tail을 만나면 그 지점에서 멈춘다.
    uint64_t replay(uint64_t after_seq, const ReplayCallback& cb) const;

    // 현재까지 할당된 마지막 시퀀스(다음 append는 +1).
    uint64_t lastSequence() const;

    const std::string& lastError() const { return last_error_; }
    const std::string& path() const { return path_; }

private:
    std::string path_;
    bool fsync_each_;
    int fd_ = -1;                 // append용 파일 디스크립터
    mutable std::mutex mutex_;
    uint64_t last_seq_ = 0;
    std::string last_error_;

    // 기존 파일을 스캔해 마지막 유효 시퀀스를 찾는다(손상 tail은 무시).
    uint64_t scanLastValidSequence() const;
};

} // namespace aws_wrapper
