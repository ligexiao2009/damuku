const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 指定输入文件
 */
const inputFile = process.argv[2];

if (!inputFile) {
  console.log('用法: node convert.js xxx.mkv');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.log('文件不存在');
  process.exit(1);
}

const ext = path.extname(inputFile);
const outputFile = inputFile.replace(ext, '.mp4');

console.log('开始转换:', inputFile);
console.log('输出文件:', outputFile);

/**
 * ffmpeg 转换（Mac GPU 加速）
 */
const cmd = `
ffmpeg -y -i "${inputFile}" \
-c:v h264_videotoolbox \
-c:a aac \
"${outputFile}"
`;

execSync(cmd, { stdio: 'inherit' });

console.log('转换完成 ✅');