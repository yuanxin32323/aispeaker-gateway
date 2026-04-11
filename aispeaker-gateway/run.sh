#!/bin/bash

echo "[INFO] 声必可网关 (AISpeaker Gateway) 正在启动..."

# 从 Add-on 选项读取配置（/data/options.json 由 Supervisor 自动生成）
if [ -f /data/options.json ]; then
  export TCP_PORT=$(jq -r '.tcp_port' /data/options.json)
  export UDP_PORT=$(jq -r '.udp_port' /data/options.json)
  export LOG_LEVEL=$(jq -r '.log_level' /data/options.json)
  echo "[INFO] TCP 端口: ${TCP_PORT}"
  echo "[INFO] UDP 端口: ${UDP_PORT}"
  echo "[INFO] 日志级别: ${LOG_LEVEL}"
fi

# SUPERVISOR_TOKEN 已由 Supervisor 自动注入到环境变量

cd /app
exec node src/index.js
