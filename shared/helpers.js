const path = require('path');
const fs = require('fs');
const {
  isPathInside,
  resolvePathInside,
  resolveDirectoryInside,
  resolveFileInside,
  isVideoExt
} = require('../utils/file');
const { FOLDERS_BASE, FOLDERS_BASES, CONVERT_HISTORY_FILE } = require('./constants');
const logger = require('../utils/logger');

function resolveLibraryDirectory(targetPath) {
  for (const base of FOLDERS_BASES) {
    try { return resolveDirectoryInside(targetPath, base); } catch {}
  }
  return resolveDirectoryInside(targetPath, FOLDERS_BASE); // fallback for error msg
}

function resolveLibraryFile(targetPath) {
  for (const base of FOLDERS_BASES) {
    try { return resolveFileInside(targetPath, base); } catch {}
  }
  return resolveFileInside(targetPath, FOLDERS_BASE);
}

function resolveLibraryVideoFile(targetPath) {
  const resolved = resolveLibraryFile(targetPath);
  if (!isVideoExt(resolved)) throw new Error('不支持的视频格式');
  return resolved;
}

function isPathValidationError(err) {
  return /^(缺少|非法|目录不存在|文件不存在|路径不是|不支持的视频格式)/.test(err?.message || '');
}

function scanFolders(baseDir, relativePath = '') {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(baseDir, relativePath), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = relativePath ? path.join(relativePath, entry.name) : entry.name;
    results.push({ path: path.join(baseDir, rel), name: rel });
    results = results.concat(scanFolders(baseDir, rel));
  }
  return results;
}

function hasDirectVideoFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).some(e => e.isFile() && isVideoExt(e.name));
  } catch {
    return false;
  }
}

function scanVideoFiles(baseDir, relativePath = '') {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(baseDir, relativePath), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(scanVideoFiles(baseDir, rel));
    } else if (isVideoExt(entry.name)) {
      results.push({ path: path.join(baseDir, rel), name: rel });
    }
  }
  return results;
}

function saveConvertHistory(task) {
  try {
    let history = [];
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
    }
    history.unshift({
      id: task.id,
      input: task.input,
      output: task.output,
      status: task.status,
      error: task.error || '',
      progress: task.progress,
      duration: task.duration,
      startTime: task.startTime,
      endTime: task.endTime
    });
    if (history.length > 50) history.length = 50;
    fs.writeFileSync(CONVERT_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    logger.error('保存转换历史失败:', err.message);
  }
}

module.exports = {
  resolveLibraryDirectory,
  resolveLibraryFile,
  resolveLibraryVideoFile,
  isPathValidationError,
  scanFolders,
  hasDirectVideoFiles,
  scanVideoFiles,
  saveConvertHistory
};
