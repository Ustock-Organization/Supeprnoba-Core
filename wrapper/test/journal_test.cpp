// LocalJournal 검증 — append/replay/앵커재생/바이너리안전/재오픈지속/손상tail.
#include "local_journal.h"
#include <cassert>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

using namespace aws_wrapper;

static int failures = 0;
static void check(bool cond, const std::string& name) {
    std::cout << (cond ? "  PASS  " : "  FAIL  ") << name << "\n";
    if (!cond) ++failures;
}

int main() {
    std::cout << "=== LocalJournal 검증 테스트 ===\n";
    const std::string path = "/tmp/sn_journal_test.wal";
    std::remove(path.c_str());

    // 1. append + 시퀀스 단조 증가
    {
        LocalJournal j(path, /*fsync_each=*/false);
        check(j.open(), "open: 신규 파일");
        uint64_t s1 = j.append("AAA", "{\"order_id\":\"o1\"}");
        uint64_t s2 = j.append("AAA", "{\"order_id\":\"o2\"}");
        uint64_t s3 = j.append("BBB", "{\"order_id\":\"o3\"}");
        check(s1 == 1 && s2 == 2 && s3 == 3, "append: 시퀀스 1,2,3");
        check(j.lastSequence() == 3, "lastSequence == 3");
    }

    // 2. 전체 재생
    {
        LocalJournal j(path, false);
        j.open();
        std::vector<std::string> got;
        uint64_t n = j.replay(0, [&](uint64_t, const std::string& k, const std::string& v) {
            got.push_back(k + "|" + v);
        });
        check(n == 3, "replay(0): 3건 재생");
        check(got.size() == 3 && got[0] == "AAA|{\"order_id\":\"o1\"}",
              "replay: 첫 레코드 정확");
        check(got[2] == "BBB|{\"order_id\":\"o3\"}", "replay: 마지막 레코드 정확");
    }

    // 3. 앵커 이후만 재생 (스냅샷 앵커=2 → seq 3만)
    {
        LocalJournal j(path, false);
        j.open();
        std::vector<uint64_t> seqs;
        uint64_t n = j.replay(2, [&](uint64_t s, const std::string&, const std::string&) {
            seqs.push_back(s);
        });
        check(n == 1 && seqs.size() == 1 && seqs[0] == 3,
              "replay(after=2): seq 3만 재생 (앵커 tail)");
    }

    // 4. 재오픈 시 시퀀스 지속 + 이어쓰기
    {
        LocalJournal j(path, false);
        j.open();
        check(j.lastSequence() == 3, "재오픈: 마지막 시퀀스 3 복원");
        uint64_t s4 = j.append("CCC", "v4");
        check(s4 == 4, "재오픈 후 append: seq 4로 이어짐");
    }

    // 5. 바이너리 안전 — 값에 개행/탭 포함
    {
        std::string path2 = "/tmp/sn_journal_bin.wal";
        std::remove(path2.c_str());
        LocalJournal j(path2, false);
        j.open();
        std::string tricky = "line1\nline2\ttabbed\n{\"nested\":\"x\"}";
        j.append("KEY\twith\ttab", tricky);
        std::string got_key, got_val;
        j.replay(0, [&](uint64_t, const std::string& k, const std::string& v) {
            got_key = k; got_val = v;
        });
        check(got_val == tricky, "바이너리안전: 개행/탭 포함 값 무손실");
        check(got_key == "KEY\twith\ttab", "바이너리안전: 탭 포함 키 무손실");
        std::remove(path2.c_str());
    }

    // 6. 손상 tail 복원력 — 부분 기록된 마지막 레코드는 무시
    {
        std::string path3 = "/tmp/sn_journal_corrupt.wal";
        std::remove(path3.c_str());
        {
            LocalJournal j(path3, false);
            j.open();
            j.append("AAA", "good1");
            j.append("AAA", "good2");
        }
        // 손상 tail 부착: 헤더는 100바이트 value를 주장하지만 실제로는 짧음.
        FILE* f = std::fopen(path3.c_str(), "ab");
        std::fputs("3 3 100\nAAAshort", f);  // vallen=100인데 실제 짧음
        std::fclose(f);

        LocalJournal j(path3, false);
        j.open();
        check(j.lastSequence() == 2, "손상tail: 마지막 유효 시퀀스 2로 복원");
        uint64_t n = j.replay(0, [](uint64_t, const std::string&, const std::string&) {});
        check(n == 2, "손상tail: 유효 2건만 재생");
        // 이어쓰기가 seq 3부터 정상 재개되는지
        uint64_t s = j.append("AAA", "good3");
        check(s == 3, "손상tail 이후 append: seq 3 재개");
        std::remove(path3.c_str());
    }

    std::remove(path.c_str());
    std::cout << "=== " << (failures == 0 ? "ALL PASS" : std::to_string(failures) + " FAIL")
              << " ===\n";
    return failures == 0 ? 0 : 1;
}
