const fs = require('fs');
const path = require('path');

/**
 * 安全解码 URI 编码的文件名，处理多次编码和 + 号。
 * @param {string} fileName
 * @returns {string}
 */
function decodeSafe(fileName) {
  try {
    if (!fileName) return '';
    let decoded = fileName.replace(/\+/g, ' ');
    while (decoded.includes('%')) {
      const prev = decoded;
      decoded = decodeURIComponent(decoded);
      if (prev === decoded) break;
    }
    return decoded;
  } catch {
    return fileName;
  }
}

/** 规范化相对路径，移除 ../ 防止目录穿越。 */
function normalizeRelativePath(relativePath) {
  const decoded = decodeSafe(relativePath);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized;
}

/**
 * 将相对文件名解析为视频目录下的绝对路径，防止目录穿越攻击。
 * @param {string} relativeName
 * @param {string} videoDir
 * @returns {string}
 */
function resolveVideoPath(relativeName, videoDir) {
  const normalized = normalizeRelativePath(relativeName);
  const fullPath = path.resolve(videoDir, normalized);
  const basePath = path.resolve(videoDir);

  if (fullPath !== basePath && !fullPath.startsWith(basePath + path.sep)) {
    throw new Error('非法路径');
  }
  return fullPath;
}

/** 判断文件扩展名是否为视频格式。 */
function isVideoExt(fileName) {
  return /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(fileName);
}

/**
 * 递归扫描目录下所有视频文件，返回相对路径数组。
 * @param {string} dir
 * @param {string} [base='']
 * @returns {string[]}
 */
function scanVideos(dir, base = '') {
  let results = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = base ? path.join(base, entry.name) : entry.name;

    if (entry.isDirectory()) {
      results = results.concat(scanVideos(fullPath, relativePath));
      continue;
    }

    if (entry.isFile() && isVideoExt(entry.name)) {
      results.push(relativePath);
    }
  }

  return results;
}

/** 获取弹幕缓存文件路径（xml 或 seg.so 策略）。 */
function getCacheFilePaths(cacheKey, strategy, danmuDir) {
  const suffix = strategy === 'seg.so' ? 'seg_so' : 'xml';
  return [path.join(danmuDir, `${cacheKey}.${suffix}.json`)];
}

/** 生成视频缩略图的缓存路径。 */
function getThumbPath(fileName, thumbDir) {
  if (!fileName) return null;
  const safeBaseName = path.basename(fileName);
  const encodedName = encodeURIComponent(safeBaseName).replace(/%/g, '_');
  return path.join(thumbDir, `${encodedName}.jpg`);
}

module.exports = {
  decodeSafe,
  normalizeRelativePath,
  resolveVideoPath,
  isVideoExt,
  scanVideos,
  getCacheFilePaths,
  getThumbPath
};
