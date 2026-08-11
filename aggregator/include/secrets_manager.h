#pragma once

#include <string>
#include <optional>
#include <memory>
#include <chrono>
#include <mutex>
#include <aws/secretsmanager/SecretsManagerClient.h>

#include "config.h"

namespace aggregator {

struct DbCredentials {
    std::string host;
    int port = 5432;
    std::string database;
    std::string username;
    std::string password;

    std::string toConnectionString() const {
        return "host=" + host +
               " port=" + std::to_string(port) +
               " dbname=" + database +
               " user=" + username +
               " password=" + password;
    }
};

class SecretsManager {
public:
    explicit SecretsManager(const Config& cfg);
    ~SecretsManager();

    // Database credentials (with 1-hour TTL caching)
    std::optional<DbCredentials> getDbCredentials();

    // Generic secret retrieval
    std::optional<std::string> getSecret(const std::string& secret_name);

    // Cache management
    void clearCache();

private:
    Config config_;
    std::unique_ptr<Aws::SecretsManager::SecretsManagerClient> client_;

    // DB credentials cache
    std::optional<DbCredentials> db_credentials_;
    std::chrono::steady_clock::time_point db_creds_expiry_;
    std::mutex db_creds_mutex_;
    static constexpr auto DB_CREDS_CACHE_TTL = std::chrono::hours(1);

    bool refreshDbCredentials();
};

} // namespace aggregator
