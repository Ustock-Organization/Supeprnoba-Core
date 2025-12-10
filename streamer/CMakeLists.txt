cmake_minimum_required(VERSION 3.14)
project(streamer VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 의존성
find_package(Threads REQUIRED)

# hiredis (Redis 클라이언트)
find_package(PkgConfig REQUIRED)
pkg_check_modules(HIREDIS REQUIRED hiredis)

# WebSocket++ 또는 uWebSockets
# 여기서는 간단히 Boost.Beast 사용
find_package(Boost REQUIRED COMPONENTS system)

# 소스 파일
set(SOURCES
    src/main.cpp
    src/redis_client.cpp
    src/websocket_server.cpp
    src/depth_broadcaster.cpp
)

# 실행 파일
add_executable(streamer ${SOURCES})

target_include_directories(streamer PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${HIREDIS_INCLUDE_DIRS}
    ${Boost_INCLUDE_DIRS}
)

target_link_libraries(streamer PRIVATE
    Threads::Threads
    ${HIREDIS_LIBRARIES}
    ${Boost_LIBRARIES}
    ssl
    crypto
)

# 설치
install(TARGETS streamer DESTINATION bin)
