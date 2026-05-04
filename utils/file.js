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

/** 判断 candidate 是否位于 baseDir 内，允许等于 baseDir。 */
function isPathInside(candidate, baseDir) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedBase = path.resolve(baseDir);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 将路径解析到允许根目录内，防止目录穿越和越权绝对路径。 */
function resolvePathInside(targetPath, baseDir) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('缺少路径');
  }
  const resolved = path.resolve(targetPath);
  if (!isPathInside(resolved, baseDir)) {
    throw new Error('非法路径');
  }
  return resolved;
}

/** 解析允许根目录内的已存在目录。 */
function resolveDirectoryInside(targetPath, baseDir) {
  const resolved = resolvePathInside(targetPath, baseDir);
  if (!fs.existsSync(resolved)) throw new Error(`目录不存在: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`路径不是目录: ${resolved}`);
  if (!isPathInside(fs.realpathSync(resolved), fs.realpathSync(baseDir))) {
    throw new Error('非法路径');
  }
  return resolved;
}

/** 解析允许根目录内的已存在文件。 */
function resolveFileInside(targetPath, baseDir) {
  const resolved = resolvePathInside(targetPath, baseDir);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`路径不是文件: ${resolved}`);
  if (!isPathInside(fs.realpathSync(resolved), fs.realpathSync(baseDir))) {
    throw new Error('非法路径');
  }
  return resolved;
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
  if (!isPathInside(fullPath, videoDir)) throw new Error('非法路径');
  return fullPath;
}

/** 将相对视频文件名解析为视频目录下已存在的视频文件。 */
function resolveExistingVideoPath(relativeName, videoDir) {
  const fullPath = resolveVideoPath(relativeName, videoDir);
  if (!fs.existsSync(fullPath)) throw new Error('视频文件不存在');
  if (!fs.statSync(fullPath).isFile()) throw new Error('路径不是文件');
  if (!isVideoExt(fullPath)) throw new Error('不支持的视频格式');
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
  // 只替换文件系统不允许的字符，保留中文
  const safe = safeBaseName.replace(/[:\/\\\*\?"<>\|]/g, '_');
  return path.join(thumbDir, `${safe}.jpg`);
}

module.exports = {
  decodeSafe,
  isPathInside,
  normalizeRelativePath,
  resolvePathInside,
  resolveDirectoryInside,
  resolveFileInside,
  resolveVideoPath,
  resolveExistingVideoPath,
  isVideoExt,
  scanVideos,
  getCacheFilePaths,
  getThumbPath
};
