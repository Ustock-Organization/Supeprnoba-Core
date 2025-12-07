#include "msk_iam_auth.h"
#include "logger.h"
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <list>
#include <curl/curl.h>

namespace aws_wrapper {

std::string MskIamAuth::getEnv(const std::string& name, const std::string& default_val) {
    const char* val = std::getenv(name.c_str());
    return val ? std::string(val) : default_val;
}

MskIamAuth::AwsCredentials MskIamAuth::getCredentials() {
    AwsCredentials creds;
    
    // 1. 환경변수에서 먼저 시도
    creds.access_key_id = getEnv("AWS_ACCESS_KEY_ID");
    creds.secret_access_key = getEnv("AWS_SECRET_ACCESS_KEY");
    creds.session_token = getEnv("AWS_SESSION_TOKEN");
    
    if (!creds.access_key_id.empty() && !creds.secret_access_key.empty()) {
        Logger::debug("Using AWS credentials from environment variables");
        return creds;
    }
    
    // 2. EC2 인스턴스 메타데이터 서비스 (IMDS)에서 가져오기
    // IMDSv2 방식 사용
    Logger::info("Fetching AWS credentials from EC2 instance metadata...");
    
    CURL* curl = curl_easy_init();
    if (!curl) {
        Logger::error("Failed to initialize curl");
        return creds;
    }
    
    // 토큰 획득 (IMDSv2)
    std::string token;
    {
        std::string response;
        struct curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, "X-aws-ec2-metadata-token-ttl-seconds: 21600");
        
        curl_easy_setopt(curl, CURLOPT_URL, "http://169.254.169.254/latest/api/token");
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, 
            +[](void* contents, size_t size, size_t nmemb, std::string* s) -> size_t {
                s->append(static_cast<char*>(contents), size * nmemb);
                return size * nmemb;
            });
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 2L);
        
        CURLcode res = curl_easy_perform(curl);
        curl_slist_free_all(headers);
        
        if (res == CURLE_OK) {
            token = response;
        }
    }
    
    if (token.empty()) {
        Logger::error("Failed to get IMDS token");
        curl_easy_cleanup(curl);
        return creds;
    }
    
    // IAM Role 이름 획득
    std::string role_name;
    {
        std::string response;
        std::string token_header = "X-aws-ec2-metadata-token: " + token;
        struct curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, token_header.c_str());
        
        curl_easy_setopt(curl, CURLOPT_URL, 
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/");
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "GET");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        
        CURLcode res = curl_easy_perform(curl);
        curl_slist_free_all(headers);
        
        if (res == CURLE_OK) {
            role_name = response;
        }
    }
    
    if (role_name.empty()) {
        Logger::error("Failed to get IAM role name");
        curl_easy_cleanup(curl);
        return creds;
    }
    
    // 자격 증명 획득
    {
        std::string response;
        std::string token_header = "X-aws-ec2-metadata-token: " + token;
        struct curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, token_header.c_str());
        
        std::string url = "http://169.254.169.254/latest/meta-data/iam/security-credentials/" + role_name;
        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        
        CURLcode res = curl_easy_perform(curl);
        curl_slist_free_all(headers);
        
        if (res == CURLE_OK) {
            // JSON 파싱 (간단한 파싱)
            auto extractValue = [&response](const std::string& key) -> std::string {
                std::string search = "\"" + key + "\" : \"";
                size_t pos = response.find(search);
                if (pos == std::string::npos) return "";
                pos += search.length();
                size_t end = response.find("\"", pos);
                if (end == std::string::npos) return "";
                return response.substr(pos, end - pos);
            };
            
            creds.access_key_id = extractValue("AccessKeyId");
            creds.secret_access_key = extractValue("SecretAccessKey");
            creds.session_token = extractValue("Token");
            
            Logger::info("Successfully obtained AWS credentials from IMDS");
        }
    }
    
    curl_easy_cleanup(curl);
    return creds;
}

std::string MskIamAuth::toHex(const unsigned char* data, size_t len) {
    std::stringstream ss;
    ss << std::hex << std::setfill('0');
    for (size_t i = 0; i < len; ++i) {
        ss << std::setw(2) << static_cast<int>(data[i]);
    }
    return ss.str();
}

std::string MskIamAuth::sha256(const std::string& data) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(data.c_str()), data.length(), hash);
    return toHex(hash, SHA256_DIGEST_LENGTH);
}

std::string MskIamAuth::hmacSha256(const std::string& key, const std::string& data) {
    unsigned char hash[EVP_MAX_MD_SIZE];
    unsigned int hash_len = 0;
    
    HMAC(EVP_sha256(), 
         key.c_str(), static_cast<int>(key.length()),
         reinterpret_cast<const unsigned char*>(data.c_str()), data.length(),
         hash, &hash_len);
    
    return std::string(reinterpret_cast<char*>(hash), hash_len);
}

std::string MskIamAuth::getSignatureKey(const std::string& key,
                                         const std::string& date_stamp,
                                         const std::string& region_name,
                                         const std::string& service_name) {
    std::string k_date = hmacSha256("AWS4" + key, date_stamp);
    std::string k_region = hmacSha256(k_date, region_name);
    std::string k_service = hmacSha256(k_region, service_name);
    std::string k_signing = hmacSha256(k_service, "aws4_request");
    return k_signing;
}

std::string MskIamAuth::generateAuthToken(const std::string& region) {
    auto creds = getCredentials();
    if (creds.access_key_id.empty() || creds.secret_access_key.empty()) {
        Logger::error("No AWS credentials available");
        return "";
    }
    
    // 현재 시간
    auto now = std::chrono::system_clock::now();
    auto time_t_now = std::chrono::system_clock::to_time_t(now);
    std::tm tm_now;
#ifdef _WIN32
    gmtime_s(&tm_now, &time_t_now);
#else
    gmtime_r(&time_t_now, &tm_now);
#endif
    
    char amz_date[20];
    strftime(amz_date, sizeof(amz_date), "%Y%m%dT%H%M%SZ", &tm_now);
    
    char date_stamp[10];
    strftime(date_stamp, sizeof(date_stamp), "%Y%m%d", &tm_now);
    
    std::string service = "kafka-cluster";
    std::string host = "kafka." + region + ".amazonaws.com";
    std::string method = "GET";
    std::string canonical_uri = "/";
    std::string algorithm = "AWS4-HMAC-SHA256";
    std::string credential_scope = std::string(date_stamp) + "/" + region + "/" + service + "/aws4_request";
    
    // Query string 생성 (presigned URL 형식)
    std::string signed_headers = "host";
    std::string canonical_headers = "host:" + host + "\n";
    std::string payload_hash = sha256("");
    
    // X-Amz-Expires 추가 (900초 = 15분)
    std::stringstream qs_ss;
    qs_ss << "Action=kafka-cluster%3AConnect"
          << "&X-Amz-Algorithm=" << algorithm
          << "&X-Amz-Credential=" << urlEncode(creds.access_key_id + "/" + credential_scope)
          << "&X-Amz-Date=" << amz_date
          << "&X-Amz-Expires=900"
          << "&X-Amz-SignedHeaders=" << signed_headers;
    if (!creds.session_token.empty()) {
        qs_ss << "&X-Amz-Security-Token=" << urlEncode(creds.session_token);
    }
    std::string canonical_querystring = qs_ss.str();
    
    // Canonical Request
    std::stringstream canonical_request_ss;
    canonical_request_ss << method << "\n"
                         << canonical_uri << "\n"
                         << canonical_querystring << "\n"
                         << canonical_headers << "\n"
                         << signed_headers << "\n"
                         << payload_hash;
    std::string canonical_request = canonical_request_ss.str();
    
    // String to Sign
    std::stringstream string_to_sign_ss;
    string_to_sign_ss << algorithm << "\n"
                      << amz_date << "\n"
                      << credential_scope << "\n"
                      << sha256(canonical_request);
    std::string string_to_sign = string_to_sign_ss.str();
    
    // Signature 생성
    std::string signing_key = getSignatureKey(creds.secret_access_key, date_stamp, region, service);
    std::string signature = toHex(
        reinterpret_cast<const unsigned char*>(hmacSha256(signing_key, string_to_sign).c_str()),
        SHA256_DIGEST_LENGTH);
    
    // Presigned URL 생성
    std::stringstream url_ss;
    url_ss << "https://" << host << canonical_uri << "?" 
           << canonical_querystring 
           << "&X-Amz-Signature=" << signature;
    std::string presigned_url = url_ss.str();
    
    // Base64 인코딩
    std::string token = base64Encode(presigned_url);
    
    Logger::debug("Generated MSK IAM auth token");
    return token;
}

// URL 인코딩 함수
std::string MskIamAuth::urlEncode(const std::string& value) {
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex;
    
    for (char c : value) {
        if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') {
            escaped << c;
        } else {
            escaped << std::uppercase;
            escaped << '%' << std::setw(2) << int(static_cast<unsigned char>(c));
            escaped << std::nouppercase;
        }
    }
    return escaped.str();
}

// Base64 인코딩 함수
std::string MskIamAuth::base64Encode(const std::string& input) {
    static const char* base64_chars = 
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz"
        "0123456789+/";
    
    std::string output;
    int val = 0, valb = -6;
    for (unsigned char c : input) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            output.push_back(base64_chars[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) {
        output.push_back(base64_chars[((val << 8) >> (valb + 8)) & 0x3F]);
    }
    while (output.size() % 4) {
        output.push_back('=');
    }
    return output;
}

bool MskIamAuth::configure(RdKafka::Conf* conf, const std::string& region) {
    std::string errstr;
    
    // SASL/SSL 설정
    if (conf->set("security.protocol", "SASL_SSL", errstr) != RdKafka::Conf::CONF_OK) {
        Logger::error("Failed to set security.protocol:", errstr);
        return false;
    }
    
    if (conf->set("sasl.mechanism", "OAUTHBEARER", errstr) != RdKafka::Conf::CONF_OK) {
        Logger::error("Failed to set sasl.mechanism:", errstr);
        return false;
    }
    
    // OAUTHBEARER 초기 토큰 설정
    std::string token = generateAuthToken(region);
    if (token.empty()) {
        Logger::error("Failed to generate initial auth token");
        return false;
    }
    
    if (conf->set("sasl.oauthbearer.token.endpoint.url", "", errstr) != RdKafka::Conf::CONF_OK) {
        // 무시 - 콜백으로 처리
    }
    
    Logger::info("MSK IAM authentication configured for region:", region);
    return true;
}

void MskOauthCallback::oauthbearer_token_refresh_cb(RdKafka::Handle* handle,
                                                     const std::string& oauthbearer_config) {
    std::string token = MskIamAuth::generateAuthToken(region_);
    
    if (token.empty()) {
        Logger::error("Failed to refresh OAUTHBEARER token");
        handle->oauthbearer_set_token_failure("Failed to generate token");
        return;
    }
    
    // 토큰 만료 시간 (현재 epoch ms + 10분)
    auto now = std::chrono::system_clock::now();
    auto epoch_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    int64_t token_expiry_ms = epoch_ms + 600000;  // 현재 + 10분
    
    std::list<std::string> extensions;  // 빈 extensions
    std::string errstr;
    
    RdKafka::ErrorCode err = handle->oauthbearer_set_token(
        token,
        token_expiry_ms,
        "kafka-cluster",  // principal
        extensions,
        errstr);
    
    if (err != RdKafka::ERR_NO_ERROR) {
        Logger::error("Failed to set OAUTHBEARER token:", errstr);
        handle->oauthbearer_set_token_failure(errstr);
    } else {
        Logger::debug("OAUTHBEARER token refreshed successfully");
    }
}

} // namespace aws_wrapper
