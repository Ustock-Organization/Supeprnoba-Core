# Liquibook AWS Wrapper - Kinesis + Valkey
cmake_minimum_required(VERSION 3.20)
project(liquibook_aws_wrapper VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Kinesis 전용 빌드
add_definitions(-DUSE_KINESIS)

# Liquibook 헤더 경로
set(LIQUIBOOK_ROOT "${CMAKE_SOURCE_DIR}/..")
include_directories(${LIQUIBOOK_ROOT}/src)
include_directories(${CMAKE_SOURCE_DIR}/include)

# 공통 의존성 (vcpkg 통해 자동 제공)
find_package(gRPC CONFIG REQUIRED)
find_package(Protobuf CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(hiredis CONFIG REQUIRED)
find_package(CURL REQUIRED)

# AWS SDK (vcpkg 통해 설치)
find_package(AWSSDK CONFIG REQUIRED COMPONENTS kinesis apigatewaymanagementapi)
message(STATUS "Building with Kinesis + API Gateway Management support")

# Proto 파일 컴파일
set(PROTO_FILES proto/snapshot.proto)
get_target_property(grpc_cpp_plugin_location gRPC::grpc_cpp_plugin LOCATION)

protobuf_generate_cpp(PROTO_SRCS PROTO_HDRS ${PROTO_FILES})
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/snapshot.grpc.pb.cc"
           "${CMAKE_CURRENT_BINARY_DIR}/snapshot.grpc.pb.h"
    COMMAND protobuf::protoc
    ARGS --grpc_out="${CMAKE_CURRENT_BINARY_DIR}"
         --plugin=protoc-gen-grpc="${grpc_cpp_plugin_location}"
         -I "${CMAKE_SOURCE_DIR}/proto"
         "${CMAKE_SOURCE_DIR}/proto/snapshot.proto"
    DEPENDS "${CMAKE_SOURCE_DIR}/proto/snapshot.proto"
)

add_library(proto_lib
    ${PROTO_SRCS}
    ${CMAKE_CURRENT_BINARY_DIR}/snapshot.grpc.pb.cc
)
target_include_directories(proto_lib PUBLIC ${CMAKE_CURRENT_BINARY_DIR})
target_link_libraries(proto_lib PUBLIC protobuf::libprotobuf gRPC::grpc++)

# 소스 파일
set(SOURCES
    src/main.cpp
    src/config.cpp
    src/order.cpp
    src/engine_core.cpp
    src/market_data_handler.cpp
    src/grpc_service.cpp
    src/redis_client.cpp
    src/metrics.cpp
    src/logger.cpp
    src/kinesis_consumer.cpp
    src/kinesis_producer.cpp
    src/notification_client.cpp
)

# 메인 실행파일
add_executable(matching_engine ${SOURCES})

# 라이브러리 링크
target_link_libraries(matching_engine PRIVATE
    proto_lib
    gRPC::grpc++
    nlohmann_json::nlohmann_json
    hiredis::hiredis
    OpenSSL::SSL
    OpenSSL::Crypto
    CURL::libcurl
    ${AWSSDK_LINK_LIBRARIES}
)
