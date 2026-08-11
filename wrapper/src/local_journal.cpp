#include "local_journal.h"
#include "logger.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <fcntl.h>    // open, O_* 플래그
#include <unistd.h>   // write, fsync, close (POSIX — 라즈베리파이/리눅스)

namespace aws_wrapper {

LocalJournal::LocalJournal(const std::string& path, bool fsync_each)
    : path_(path), fsync_each_(fsync_each) {}

LocalJournal::~LocalJournal() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (fd_ >= 0) {
        ::fsync(fd_);
        ::close(fd_);
        fd_ = -1;
    }
}

// 헤더 한 줄에서 seq/keylen/vallen 파싱. 성공 시 true.
static bool parseHeader(const std::string& line, uint64_t& seq,
                        size_t& keylen, size_t& vallen) {
    unsigned long long s = 0, k = 0, v = 0;
    if (std::sscanf(line.c_str(), "%llu %llu %llu", &s, &k, &v) != 3) return false;
    seq = static_cast<uint64_t>(s);
    keylen = static_cast<size_t>(k);
    vallen = static_cast<size_t>(v);
    return true;
}

uint64_t LocalJournal::scanLastValidSequence() const {
    std::ifstream in(path_, std::ios::binary);
    if (!in.is_open()) return 0;

    uint64_t last = 0;
    while (true) {
        std::string header;
        if (!std::getline(in, header)) break;
        if (header.empty()) continue;

        uint64_t seq;
        size_t keylen, vallen;
        if (!parseHeader(header, seq, keylen, vallen)) break;  // 손상 tail

        // key + value + 종료 개행을 소비.
        std::string buf;
        buf.resize(keylen + vallen + 1);
        in.read(&buf[0], static_cast<std::streamsize>(keylen + vallen + 1));
        if (static_cast<size_t>(in.gcount()) != keylen + vallen + 1) break;  // 부분 기록

        last = seq;
    }
    return last;
}

bool LocalJournal::open() {
    std::lock_guard<std::mutex> lock(mutex_);

    last_seq_ = scanLastValidSequence();

    fd_ = ::open(path_.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd_ < 0) {
        last_error_ = std::string("open() failed: ") + std::strerror(errno) + " (" + path_ + ")";
        Logger::error("LocalJournal:", last_error_);
        return false;
    }
    Logger::info("LocalJournal opened:", path_, "resume from seq:", last_seq_);
    return true;
}

uint64_t LocalJournal::append(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (fd_ < 0) {
        last_error_ = "append on closed journal";
        return 0;
    }

    uint64_t seq = last_seq_ + 1;

    // 헤더 + key + value + 개행을 하나의 버퍼로 조립해 단일 write로 원자성↑.
    std::string rec;
    rec.reserve(32 + key.size() + value.size());
    rec += std::to_string(seq);
    rec += ' ';
    rec += std::to_string(key.size());
    rec += ' ';
    rec += std::to_string(value.size());
    rec += '\n';
    rec += key;
    rec += value;
    rec += '\n';

    size_t written = 0;
    while (written < rec.size()) {
        ssize_t n = ::write(fd_, rec.data() + written, rec.size() - written);
        if (n < 0) {
            last_error_ = std::string("write() failed at seq ") + std::to_string(seq)
                        + ": " + std::strerror(errno);
            Logger::error("LocalJournal:", last_error_);
            return 0;
        }
        written += static_cast<size_t>(n);
    }

    if (fsync_each_ && ::fsync(fd_) != 0) {
        last_error_ = std::string("fsync() failed at seq ") + std::to_string(seq)
                    + ": " + std::strerror(errno);
        Logger::error("LocalJournal:", last_error_);
        return 0;
    }

    last_seq_ = seq;
    return seq;
}

uint64_t LocalJournal::replay(uint64_t after_seq, const ReplayCallback& cb) const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ifstream in(path_, std::ios::binary);
    if (!in.is_open()) return 0;

    uint64_t replayed = 0;
    while (true) {
        std::string header;
        if (!std::getline(in, header)) break;
        if (header.empty()) continue;

        uint64_t seq;
        size_t keylen, vallen;
        if (!parseHeader(header, seq, keylen, vallen)) break;

        std::string key, value;
        key.resize(keylen);
        value.resize(vallen);
        in.read(&key[0], static_cast<std::streamsize>(keylen));
        in.read(&value[0], static_cast<std::streamsize>(vallen));
        char nl = 0;
        in.read(&nl, 1);
        if (in.gcount() != 1) break;  // 부분 기록 tail

        if (seq > after_seq) {
            cb(seq, key, value);
            ++replayed;
        }
    }
    return replayed;
}

uint64_t LocalJournal::lastSequence() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_seq_;
}

} // namespace aws_wrapper
