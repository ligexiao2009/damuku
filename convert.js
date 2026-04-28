const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 指定输入文件
 */
const inputFile = process.argv[2];

if (!inputFile) {
  console.log('用法: node convert.js <视频文件.mkv>');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.log('❌ 文件不存在:', inputFile);
  process.exit(1);
}

// 1. 更安全地解析和生成输出路径
const parsedPath = path.parse(inputFile);
const outputFile = path.join(
  parsedPath.dir, 
  `${parsedPath.name}_converted.mp4`
);

console.log('🚀 开始转换:', inputFile);
console.log('📁 输出文件:', outputFile);

// 2. 使用数组传递参数，避免文件名包含引号等特殊字符导致 Shell 注入或命令解析错误
const args = [
  '-y',                 // 覆盖输出文件
  '-i', inputFile,      // 输入文件
  '-c:v', 'h264_videotoolbox', // Mac GPU 硬件加速
  // '-b:v', '5000k',   // 可选：如果发现画质变差，可以解除此行注释强制指定视频码率
  '-c:a', 'aac',        // 音频编码
  outputFile            // 输出文件
];

try {
  // 3. 使用 spawnSync 替代 execSync，更安全
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });

  // 4. 增加完善的错误状态捕捉
  if (result.error) {
    console.error('\n❌ 执行失败！请检查系统是否已安装 ffmpeg (如: brew install ffmpeg)');
    console.error('详细错误:', result.error.message);
  } else if (result.status !== 0) {
    console.error(`\n❌ 转换异常中断，ffmpeg 退出码: ${result.status}`);
  } else {
    console.log('\n✅ 转换完成！');
  }
} catch (err) {
  console.error('\n❌ 发生未知异常:', err);
}