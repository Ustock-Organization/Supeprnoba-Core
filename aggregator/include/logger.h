#pragma once

#include <string>
#include <vector>
#include <iostream>
#include <sstream>
#include <chrono>
#include <iomanip>

namespace aggregator {

enum class LogLevel { DEBUG, INFO, WARN, ERROR };

class Logger {
public:
    static void set_level(const std::string& level);
    static LogLevel get_level();
    
    template<typename... Args>
    static void debug(Args&&... args) {
        if (level_ <= LogLevel::DEBUG) log("[DEBUG]", std::forward<Args>(args)...);
    }
    
    template<typename... Args>
    static void info(Args&&... args) {
        if (level_ <= LogLevel::INFO) log("[INFO]", std::forward<Args>(args)...);
    }
    
    template<typename... Args>
    static void warn(Args&&... args) {
        if (level_ <= LogLevel::WARN) log("[WARN]", std::forward<Args>(args)...);
    }
    
    template<typename... Args>
    static void error(Args&&... args) {
        if (level_ <= LogLevel::ERROR) log("[ERROR]", std::forward<Args>(args)...);
    }

private:
    static LogLevel level_;
    
    template<typename... Args>
    static void log(const std::string& prefix, Args&&... args) {
        auto now = std::chrono::system_clock::now();
        auto time = std::chrono::system_clock::to_time_t(now);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()) % 1000;
        
        std::ostringstream oss;
        oss << std::put_time(std::localtime(&time), "[%Y-%m-%d %H:%M:%S.");
        oss << std::setfill('0') << std::setw(3) << ms.count() << "] ";
        oss << prefix << " ";
        ((oss << args << " "), ...);
        std::cout << oss.str() << std::endl;
    }
};

} // namespace aggregator
