#pragma once

#include <iostream>
#include <string>
#include <chrono>
#include <iomanip>
#include <sstream>

namespace aws_wrapper {

enum class LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
};

class Logger {
public:
    static void setLevel(LogLevel level) { level_ = level; }
    static LogLevel getLevel() { return level_; }

    template<typename... Args>
    static void debug(const std::string& msg, Args&&... args) {
        log(LogLevel::DEBUG, "DEBUG", msg, std::forward<Args>(args)...);
    }

    template<typename... Args>
    static void info(const std::string& msg, Args&&... args) {
        log(LogLevel::INFO, "INFO", msg, std::forward<Args>(args)...);
    }

    template<typename... Args>
    static void warn(const std::string& msg, Args&&... args) {
        log(LogLevel::WARN, "WARN", msg, std::forward<Args>(args)...);
    }

    template<typename... Args>
    static void error(const std::string& msg, Args&&... args) {
        log(LogLevel::ERROR, "ERROR", msg, std::forward<Args>(args)...);
    }

private:
    static inline LogLevel level_ = LogLevel::INFO;

    static std::string timestamp() {
        auto now = std::chrono::system_clock::now();
        auto time = std::chrono::system_clock::to_time_t(now);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()) % 1000;
        
        std::stringstream ss;
        ss << std::put_time(std::localtime(&time), "%Y-%m-%d %H:%M:%S");
        ss << '.' << std::setfill('0') << std::setw(3) << ms.count();
        return ss.str();
    }

    template<typename... Args>
    static void log(LogLevel level, const char* levelStr, 
                    const std::string& msg, Args&&... args) {
        if (level < level_) return;
        
        std::cout << "[" << timestamp() << "] [" << levelStr << "] " 
                  << msg;
        ((std::cout << " " << args), ...);
        std::cout << std::endl;
    }
};

} // namespace aws_wrapper
