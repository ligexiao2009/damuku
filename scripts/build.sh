#!/bin/bash
set -e
cd "$(dirname "$0")/.."

START=$(date +%s)

echo "=== B站弹幕外挂 打包脚本 ==="

# Clean old DMG only
rm -f dist/*.dmg dist/*.blockmap 2>/dev/null

# Bump version
npm version patch --no-git-tag-version

# Build
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder build --mac dmg \
    --config.dmg.writeUpdateInfo=false

END=$(date +%s)
DURATION=$((END - START))
MIN=$((DURATION / 60))
SEC=$((DURATION % 60))

echo ""
echo "=== 打包完成 ==="
ls -lh dist/*.dmg 2>/dev/null
echo ""
echo "耗时: ${MIN}分${SEC}秒"
