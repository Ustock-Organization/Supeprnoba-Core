#!/bin/bash
# Supernoba log cleanup — safety net for logrotate
# Runs weekly via /etc/cron.weekly/
# Deletes compressed log archives older than 14 days
# (logrotate handles rotation, but dateformat changes can orphan old files)

find /var/log/supernoba -name "*.gz" -mtime +14 -delete 2>/dev/null
find /var/log/supernoba -name "*.log-*" -mtime +14 -delete 2>/dev/null
