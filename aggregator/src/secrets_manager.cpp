#include "secrets_manager.h"
#include "logger.h"

#include <aws/core/utils/Outcome.h>
#include <aws/secretsmanager/model/GetSecretValueRequest.h>
#include <nlohmann/json.hpp>
#include <iostream>

namespace aggregator {

SecretsManager::SecretsManager(const Config& cfg)
    : config_(cfg) {

    Aws::Client::ClientConfiguration clientConfig;
    clientConfig.region = cfg.aws_region;
    clientConfig.connectTimeoutMs = 5000;
    clientConfig.requestTimeoutMs = 10000;

    client_ = std::make_unique<Aws::SecretsManager::SecretsManagerClient>(clientConfig);

    Logger::info("SecretsManager initialized for region:", cfg.aws_region);
}

SecretsManager::~SecretsManager() = default;

std::optional<DbCredentials> SecretsManager::getDbCredentials() {
    std::lock_guard<std::mutex> lock(db_creds_mutex_);

    auto now = std::chrono::steady_clock::now();
    if (db_credentials_.has_value() && now < db_creds_expiry_) {
        return db_credentials_;
    }

    // Refresh credentials
    if (refreshDbCredentials()) {
        return db_credentials_;
    }

    return std::nullopt;
}

std::optional<std::string> SecretsManager::getSecret(const std::string& secret_name) {
    Aws::SecretsManager::Model::GetSecretValueRequest request;
    request.SetSecretId(secret_name);

    auto outcome = client_->GetSecretValue(request);

    if (!outcome.IsSuccess()) {
        Logger::error("Failed to get secret", secret_name, ":",
                     outcome.GetError().GetMessage());
        return std::nullopt;
    }

    return outcome.GetResult().GetSecretString();
}

bool SecretsManager::refreshDbCredentials() {
    // Note: mutex should be held by caller
    auto secret = getSecret(config_.db_credentials_secret_name);
    if (!secret.has_value()) {
        Logger::error("Failed to refresh DB credentials from secret:",
                     config_.db_credentials_secret_name);
        return false;
    }

    try {
        auto json = nlohmann::json::parse(secret.value());

        DbCredentials creds;
        creds.host = json.value("host", "");
        creds.port = json.value("port", 5432);
        creds.database = json.value("database", json.value("dbname", ""));
        creds.username = json.value("username", "");
        creds.password = json.value("password", "");

        if (creds.host.empty() || creds.username.empty() || creds.database.empty()) {
            Logger::error("Invalid DB credentials format in secret");
            return false;
        }

        db_credentials_ = std::move(creds);
        db_creds_expiry_ = std::chrono::steady_clock::now() + DB_CREDS_CACHE_TTL;

        Logger::info("DB credentials loaded from Secrets Manager (TTL: 1 hour)");
        return true;

    } catch (const std::exception& e) {
        Logger::error("Failed to parse DB credentials:", e.what());
        return false;
    }
}

void SecretsManager::clearCache() {
    std::lock_guard<std::mutex> lock(db_creds_mutex_);
    db_credentials_.reset();
    db_creds_expiry_ = std::chrono::steady_clock::time_point{};
}

} // namespace aggregator
