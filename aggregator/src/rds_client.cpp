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
    
    std::string sql = "SELECT create_candle_partition_if_not_exists($1)";
    const char* params[1] = {symbol.c_str()};
    
    PGresult* res = PQexecParams(conn_, sql.c_str(), 1, nullptr, params, nullptr, nullptr, 0);
    
    if (PQresultStatus(res) != PGRES_TUPLES_OK && PQresultStatus(res) != PGRES_COMMAND_OK) {
        Logger::error("RDS partition creation failed:", PQerrorMessage(conn_));
        PQclear(res);
        return false;
    }
    
    PQclear(res);
    return true;
}

bool RdsClient::put_candle(const std::string& symbol, const std::string& interval, 
                           const Candle& candle) {
    if (!connected_ || !conn_) return false;
    
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
        symbol.c_str(), interval.c_str(), epoch_str.c_str(), candle.time.c_str(),
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

} // namespace aggregator
