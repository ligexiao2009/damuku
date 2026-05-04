#!/bin/bash
# 启动后端服务
# 使用方式: ./start_server.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# 检测 5001 端口是否占用，占用就杀掉
PORT=5001
PID=$(lsof -ti :$PORT)
if [ -n "$PID" ]; then
  echo "=== 端口 $PORT 被进程 $PID 占用，正在关闭 ==="
  kill -9 $PID 2>/dev/null
  sleep 1
fi

echo "=== 启动后端服务 ==="
node server.js "$@" &
SERVER_PID=$!
python3 scripts/iina-watcher.py &


