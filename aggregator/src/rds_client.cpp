#include "rds_client.h"
#include "logger.h"

#include <libpq-fe.h>
#include <sstream>
#include <iomanip>

namespace aggregator {

RdsClient::RdsClient(const std::string& host, int port, const std::string& dbname,
                     const std::string& user, const std::string& password)
    : host_(host), port_(port), dbname_(dbname), user_(user), password_(password),
      conn_(nullptr), connected_(false) {}

RdsClient::~RdsClient() {
    disconnect();
}

bool RdsClient::connect() {
    std::ostringstream conninfo;
    conninfo << "host=" << host_ 
             << " port=" << port_
             << " dbname=" << dbname_
             << " user=" << user_
             << " password=" << password_
             << " sslmode=require"
             << " connect_timeout=5";
    
    conn_ = PQconnectdb(conninfo.str().c_str());
    
    if (PQstatus(conn_) != CONNECTION_OK) {
        Logger::error("RDS connection failed:", PQerrorMessage(conn_));
        PQfinish(conn_);
        conn_ = nullptr;
        return false;
    }
    
    connected_ = true;
    Logger::info("RDS connected:", host_, ":", port_, "/", dbname_);
    return true;
}

void RdsClient::disconnect() {
    if (conn_) {
        PQfinish(conn_);
        conn_ = nullptr;
        connected_ = false;
    }
}

bool RdsClient::ensure_partition(const std::string& symbol) {
    if (!connected_ || !conn_) return false;
    
    // 소문자로 변환
    std::string lower_symbol = symbol;
    for (auto& c : lower_symbol) c = std::tolower(c);
    
    // 파티션 존재 확인
    std::string check_sql = "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'candle_history_" + lower_symbol + "'";
    PGresult* check_res = PQexec(conn_, check_sql.c_str());
    
    if (PQresultStatus(check_res) == PGRES_TUPLES_OK && PQntuples(check_res) > 0) {
        // 이미 존재함 - 생성 스킵
        PQclear(check_res);
        return true;
    }
    PQclear(check_res);
    
    // 파티션 생성 (소문자)
    std::string create_sql = "CREATE TABLE IF NOT EXISTS public.candle_history_" + lower_symbol + 
                             " PARTITION OF public.candle_history FOR VALUES IN ('" + lower_symbol + "')";
    PGresult* res = PQexec(conn_, create_sql.c_str());
    
    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS partition creation failed:", PQerrorMessage(conn_));
        PQclear(res);
        return false;
    }
    
    PQclear(res);
    Logger::info("Created partition: candle_history_", lower_symbol);
    return true;
}

bool RdsClient::put_candle(const std::string& symbol, const std::string& interval, 
                           const Candle& candle) {
    if (!connected_ || !conn_) return false;
    
    // 소문자로 변환 (파티션 키와 일치)
    std::string lower_symbol = symbol;
    for (auto& c : lower_symbol) c = std::tolower(c);
    
    std::string sql = R"(
        INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (symbol, interval, time_epoch) 
        DO UPDATE SET high = GREATEST(candle_history.high, EXCLUDED.high),
                      low = LEAST(candle_history.low, EXCLUDED.low),
                      close = EXCLUDED.close,
                      volume = candle_history.volume + EXCLUDED.volume
    )";
    
    std::string epoch_str = std::to_string(candle.epoch());
    std::string open_str = std::to_string(candle.open);
    std::string high_str = std::to_string(candle.high);
    std::string low_str = std::to_string(candle.low);
    std::string close_str = std::to_string(candle.close);
    std::string volume_str = std::to_string(candle.volume);
    
    const char* params[9] = {
        lower_symbol.c_str(), interval.c_str(), epoch_str.c_str(), candle.time.c_str(),
        open_str.c_str(), high_str.c_str(), low_str.c_str(), close_str.c_str(), volume_str.c_str()
    };
    
    PGresult* res = PQexecParams(conn_, sql.c_str(), 9, nullptr, params, nullptr, nullptr, 0);
    
    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS put_candle failed:", PQerrorMessage(conn_));
        PQclear(res);
        return false;
    }
    
    PQclear(res);
    return true;
}

bool RdsClient::put_candle_replace(const std::string& symbol, const std::string& interval,
                                    const Candle& candle) {
    if (!connected_ || !conn_) return false;

    std::string lower_symbol = symbol;
    for (auto& c : lower_symbol) c = std::tolower(c);

    std::string sql = R"(
        INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (symbol, interval, time_epoch)
        DO UPDATE SET open = EXCLUDED.open,
                      high = EXCLUDED.high,
                      low = EXCLUDED.low,
                      close = EXCLUDED.close,
                      volume = EXCLUDED.volume
    )";

    std::string epoch_str = std::to_string(candle.epoch());
    std::string open_str = std::to_string(candle.open);
    std::string high_str = std::to_string(candle.high);
    std::string low_str = std::to_string(candle.low);
    std::string close_str = std::to_string(candle.close);
    std::string volume_str = std::to_string(candle.volume);

    const char* params[9] = {
        lower_symbol.c_str(), interval.c_str(), epoch_str.c_str(), candle.time.c_str(),
        open_str.c_str(), high_str.c_str(), low_str.c_str(), close_str.c_str(), volume_str.c_str()
    };

    PGresult* res = PQexecParams(conn_, sql.c_str(), 9, nullptr, params, nullptr, nullptr, 0);

    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS put_candle_replace failed:", PQerrorMessage(conn_));
        PQclear(res);
        return false;
    }

    PQclear(res);
    return true;
}

int RdsClient::batch_put_candles(const std::string& symbol, const std::string& interval,
                                 const std::vector<Candle>& candles) {
    if (!connected_ || !conn_ || candles.empty()) return 0;
    
    // 파티션 확인
    ensure_partition(symbol);
    
    // BEGIN TRANSACTION
    PGresult* res = PQexec(conn_, "BEGIN");
    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS BEGIN failed:", PQerrorMessage(conn_));
        PQclear(res);
        return 0;
    }
    PQclear(res);
    
    int saved = 0;
    for (const auto& candle : candles) {
        if (put_candle(symbol, interval, candle)) {
            saved++;
        }
    }
    
    // COMMIT
    res = PQexec(conn_, "COMMIT");
    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS COMMIT failed:", PQerrorMessage(conn_));
        PQexec(conn_, "ROLLBACK");
        PQclear(res);
        return 0;
    }
    PQclear(res);
    
    return saved;
}

// [Phase 3] 계층적 집계를 위한 캔들 조회
std::vector<Candle> RdsClient::get_candles_by_interval(
    const std::string& symbol,
    const std::string& interval,
    int64_t start_epoch,
    int64_t end_epoch) {

    std::vector<Candle> candles;
    if (!connected_ || !conn_) return candles;

    // 소문자로 변환 (파티션 키와 일치)
    std::string lower_symbol = symbol;
    for (auto& c : lower_symbol) c = std::tolower(c);

    std::string sql = R"(
        SELECT time_ymdhm, open, high, low, close, volume
        FROM candle_history
        WHERE symbol = $1 AND interval = $2
          AND time_epoch >= $3 AND time_epoch < $4
        ORDER BY time_epoch ASC
    )";

    std::string start_str = std::to_string(start_epoch);
    std::string end_str = std::to_string(end_epoch);

    const char* params[4] = {
        lower_symbol.c_str(), interval.c_str(),
        start_str.c_str(), end_str.c_str()
    };

    PGresult* res = PQexecParams(conn_, sql.c_str(), 4, nullptr, params, nullptr, nullptr, 0);

    if (PQresultStatus(res) != PGRES_TUPLES_OK) {
        Logger::error("RDS get_candles_by_interval failed:", PQerrorMessage(conn_));
        PQclear(res);
        return candles;
    }

    int rows = PQntuples(res);
    for (int i = 0; i < rows; i++) {
        Candle c;
        c.symbol = symbol;
        c.time = PQgetvalue(res, i, 0);  // time_ymdhm
        c.open = std::stod(PQgetvalue(res, i, 1));
        c.high = std::stod(PQgetvalue(res, i, 2));
        c.low = std::stod(PQgetvalue(res, i, 3));
        c.close = std::stod(PQgetvalue(res, i, 4));
        c.volume = std::stod(PQgetvalue(res, i, 5));
        candles.push_back(c);
    }

    PQclear(res);
    Logger::debug("RDS get_candles:", symbol, interval, "range:",
                 start_epoch, "-", end_epoch, "found:", rows);
    return candles;
}

// === 전일종가 관리 ===

bool RdsClient::update_prev_close(const std::string& symbol, double close_price,
                                   const std::string& trading_date) {
    if (!connected_ || !conn_) return false;

    // 대문자로 변환 (symbol_prev_close는 대문자 사용)
    std::string upper_symbol = symbol;
    for (auto& c : upper_symbol) c = std::toupper(c);

    std::string sql = R"(
        INSERT INTO symbol_prev_close (symbol, prev_close, prev_trading_date, last_close, last_trading_date)
        VALUES ($1, $2, $3::DATE, $2, $3::DATE)
        ON CONFLICT (symbol)
        DO UPDATE SET
            prev_close = EXCLUDED.prev_close,
            prev_trading_date = EXCLUDED.prev_trading_date,
            last_close = EXCLUDED.last_close,
            last_trading_date = EXCLUDED.last_trading_date,
            updated_at = now()
    )";

    std::string close_str = std::to_string(close_price);

    const char* params[3] = {
        upper_symbol.c_str(), close_str.c_str(), trading_date.c_str()
    };

    PGresult* res = PQexecParams(conn_, sql.c_str(), 3, nullptr, params, nullptr, nullptr, 0);

    if (PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS update_prev_close failed:", PQerrorMessage(conn_));
        PQclear(res);
        return false;
    }

    PQclear(res);
    Logger::info("[PREV-CLOSE] RDS updated:", upper_symbol, "=", close_price, "date:", trading_date);
    return true;
}

} // namespace aggregator
