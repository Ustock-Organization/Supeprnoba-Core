# Candle Aggregator - Real-time Timeframe Processor (RDS PostgreSQL)
cmake_minimum_required(VERSION 3.20)
project(candle_aggregator VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# 헤더 경로
include_directories(${CMAKE_SOURCE_DIR}/include)

# 공통 의존성 (vcpkg 통해 자동 제공)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(hiredis CONFIG REQUIRED)
find_package(CURL REQUIRED)

# PostgreSQL (libpq)
find_package(PostgreSQL REQUIRED)
message(STATUS "Building Candle Aggregator with RDS PostgreSQL support")

# 소스 파일
set(SOURCES
    src/main.cpp
    src/config.cpp
    src/logger.cpp
    src/valkey_client.cpp
    src/aggregator.cpp
    src/rds_client.cpp
)

# 메인 실행파일
add_executable(candle_aggregator ${SOURCES})

# 라이브러리 링크
target_link_libraries(candle_aggregator PRIVATE
    nlohmann_json::nlohmann_json
    hiredis::hiredis
    OpenSSL::SSL
    OpenSSL::Crypto
    CURL::libcurl
    PostgreSQL::PostgreSQL
)
