#!/usr/bin/with-contenv bashio

bashio::log.info "声必可网关 (AISpeaker Gateway) 正在启动..."

# 从 Add-on 选项读取配置
export TCP_PORT=$(bashio::config 'tcp_port')
export UDP_PORT=$(bashio::config 'udp_port')
export LOG_LEVEL=$(bashio::config 'log_level')

bashio::log.info "TCP 端口: ${TCP_PORT}"
bashio::log.info "UDP 端口: ${UDP_PORT}"
bashio::log.info "日志级别: ${LOG_LEVEL}"

# SUPERVISOR_TOKEN 已由 Supervisor 自动注入到环境变量

cd /app
exec node src/index.js
