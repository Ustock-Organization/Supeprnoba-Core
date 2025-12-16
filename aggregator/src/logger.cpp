#include "logger.h"
#include <algorithm>

namespace aggregator {

LogLevel Logger::level_ = LogLevel::INFO;

void Logger::set_level(const std::string& level) {
    std::string upper = level;
    std::transform(upper.begin(), upper.end(), upper.begin(), ::toupper);
    
    if (upper == "DEBUG") level_ = LogLevel::DEBUG;
    else if (upper == "INFO") level_ = LogLevel::INFO;
    else if (upper == "WARN") level_ = LogLevel::WARN;
    else if (upper == "ERROR") level_ = LogLevel::ERROR;
    else level_ = LogLevel::INFO;
}

LogLevel Logger::get_level() {
    return level_;
}

} // namespace aggregator
