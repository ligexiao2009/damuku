#!/bin/bash
# 文件名: generate_danmu_icns.command
# 说明: 将同文件夹下的 Danmu_1024.png 生成 macOS icns 并输出到桌面

# 自动获取当前脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_PNG="$SCRIPT_DIR/Danmu_1024.png"

# 检查 PNG 是否存在
if [ ! -f "$INPUT_PNG" ]; then
    echo "Error: Danmu_1024.png not found in script folder!"
    echo "Please place your 1024x1024 PNG icon in the same folder as this script."
    exit 1
fi

OUTPUT_DIR="$HOME/Desktop"
ICONSET="$OUTPUT_DIR/Danmu.iconset"
mkdir -p "$ICONSET"

echo "Generating iconset files..."

# 生成不同尺寸 PNG
sips -z 16 16     "$INPUT_PNG" --out "$ICONSET/icon_16x16.png"
sips -z 32 32     "$INPUT_PNG" --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32     "$INPUT_PNG" --out "$ICONSET/icon_32x32.png"
sips -z 64 64     "$INPUT_PNG" --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128   "$INPUT_PNG" --out "$ICONSET/icon_128x128.png"
sips -z 256 256   "$INPUT_PNG" --out "$ICONSET/icon_128x128@2x.png"
sips -z 256 256   "$INPUT_PNG" --out "$ICONSET/icon_256x256.png"
sips -z 512 512   "$INPUT_PNG" --out "$ICONSET/icon_256x256@2x.png"
sips -z 512 512   "$INPUT_PNG" --out "$ICONSET/icon_512x512.png"
cp "$INPUT_PNG" "$ICONSET/icon_512x512@2x.png"

echo "Packing iconset into icns..."

# 打包成 icns
iconutil -c icns "$ICONSET" -o "$OUTPUT_DIR/Danmu.icns"

echo "Done! icns file created on your Desktop: Danmu.icns"
echo "You can now use it for your Electron macOS App."