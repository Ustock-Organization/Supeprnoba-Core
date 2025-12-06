# Liquibook AWS Wrapper
cmake_minimum_required(VERSION 3.20)
project(liquibook_aws_wrapper VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Liquibook 헤더 경로
set(LIQUIBOOK_ROOT "${CMAKE_SOURCE_DIR}/..")
include_directories(${LIQUIBOOK_ROOT}/src)
include_directories(${CMAKE_SOURCE_DIR}/include)

# 의존성 찾기 (vcpkg 통합 시 자동)
find_package(RdKafka CONFIG REQUIRED)
find_package(gRPC CONFIG REQUIRED)
find_package(Protobuf CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(hiredis CONFIG REQUIRED)

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

# 메인 실행파일
add_executable(matching_engine
    src/main.cpp
    src/config.cpp
    src/order.cpp
    src/engine_core.cpp
    src/kafka_consumer.cpp
    src/kafka_producer.cpp
    src/market_data_handler.cpp
    src/grpc_service.cpp
    src/redis_client.cpp
    src/metrics.cpp
    src/logger.cpp
    src/msk_iam_auth.cpp
    src/websocket_server.cpp
)

target_link_libraries(matching_engine PRIVATE
    proto_lib
    RdKafka::rdkafka++
    gRPC::grpc++
    nlohmann_json::nlohmann_json
    hiredis::hiredis
    OpenSSL::SSL
    OpenSSL::Crypto
)

# 테스트 (테스트 파일 생성 후 활성화)
# enable_testing()
# find_package(GTest CONFIG)
# if(GTest_FOUND AND EXISTS "${CMAKE_SOURCE_DIR}/test/test_order.cpp")
#     add_executable(test_engine
#         test/test_order.cpp
#         test/test_engine_core.cpp
#         src/order.cpp
#         src/engine_core.cpp
#         src/market_data_handler.cpp
#     )
#     target_link_libraries(test_engine PRIVATE
#         proto_lib
#         GTest::gtest_main
#         RdKafka::rdkafka++
#         nlohmann_json::nlohmann_json
#     )
#     add_test(NAME EngineTests COMMAND test_engine)
# endif()

