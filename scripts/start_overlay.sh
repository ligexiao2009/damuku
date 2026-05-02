#!/bin/bash
# 启动后端服务 + Electron 悬浮弹幕窗口
# 使用方式: ./start_overlay.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "=== 启动后端服务 ==="
node server.js &
SERVER_PID=$!

# 等待服务启动
sleep 2

echo "=== 启动 Electron 悬浮窗 ==="
npm run overlay

# Electron 退出后，关掉后端服务
kill $SERVER_PID 2>/dev/null
echo "=== 已退出 ==="
