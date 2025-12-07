#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <string>
#include <memory>
#include <chrono>
#include <ctime>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <iomanip>
#include <sstream>

namespace aws_wrapper {

/**
 * MSK IAM Authentication Helper
 * 
 * librdkafka의 OAUTHBEARER 콜백을 통해 AWS SigV4 토큰 생성
 * 참고: https://docs.aws.amazon.com/msk/latest/developerguide/iam-access-control.html
 */
class MskIamAuth {
public:
    /**
     * Kafka Conf에 MSK IAM 인증 설정 적용
     * 
     * @param conf librdkafka configuration
     * @param region AWS 리전 (예: ap-northeast-2)
     * @return true if successful
     */
    static bool configure(RdKafka::Conf* conf, const std::string& region);

    /**
     * EC2 인스턴스 메타데이터에서 IAM 자격 증명 가져오기
     * (EC2 인스턴스 프로파일 또는 환경변수 사용)
     */
    struct AwsCredentials {
        std::string access_key_id;
        std::string secret_access_key;
        std::string session_token;  // 임시 자격 증명용 (선택)
    };
    
    static AwsCredentials getCredentials();

    /**
     * OAUTHBEARER 토큰 생성
     * AWS SigV4 형식의 인증 토큰 반환
     */
    static std::string generateAuthToken(const std::string& region);

private:
    static std::string getEnv(const std::string& name, const std::string& default_val = "");
    static std::string hmacSha256(const std::string& key, const std::string& data);
    static std::string sha256(const std::string& data);
    static std::string toHex(const unsigned char* data, size_t len);
    static std::string getSignatureKey(const std::string& key, 
                                        const std::string& date_stamp,
                                        const std::string& region_name,
                                        const std::string& service_name);
    static std::string urlEncode(const std::string& value);
    static std::string base64Encode(const std::string& input);
};

/**
 * OAUTHBEARER 토큰 리프레시 콜백
 */
class MskOauthCallback : public RdKafka::OAuthBearerTokenRefreshCb {
public:
    explicit MskOauthCallback(const std::string& region) : region_(region) {}
    
    void oauthbearer_token_refresh_cb(RdKafka::Handle* handle,
                                       const std::string& oauthbearer_config) override;

private:
    std::string region_;
};

} // namespace aws_wrapper
