/**
 * Auto-rename: watches video directories. When a new video file appears,
 * scans the directory for platform IDs (BV/VID/tvid) and auto-triggers
 * the rename API to batch-rename all video files in that directory.
 */
const fs = require('fs');
const path = require('path');
const { FOLDERS_BASE } = require('../shared/constants');
const { isVideoExt, scanVideos } = require('../utils/file');
const logger = require('../utils/logger');

// Debounce map: folderPath -> timeoutId
const pending = new Map();

function detectPlatformAndID(files) {
  for (const name of files) {
    // B站 BV 号
    const bv = name.match(/BV[0-9A-Za-z]+/i);
    if (bv) return { platform: 'bili', id: bv[0] };
    // 腾讯 VID (子目录的相对路径也要检查文件名部分)
    const base = path.basename(name);
    const tencent = base.match(/(?:^|[_\s-])([a-z][a-z0-9]{9,11})(?=$|[_\s-.])/i);
    if (tencent) return { platform: 'tencent', id: tencent[1] };
    // 爱奇艺 tvid
    const iqiyi = base.match(/(\d{9,16})/);
    if (iqiyi) return { platform: 'iqiyi', id: iqiyi[0] };
  }
  return null;
}

async function triggerRename(folderPath, platform, id) {
  const body = platform === 'bili' ? { folderPath, biliUrl: `ep${id}` }
    : platform === 'tencent' ? { folderPath, cidOrVid: id }
    : { folderPath, tvid: id };

  try {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/rename${platform === 'iqiyi' ? '/iqiyi' : platform === 'tencent' ? '/tencent' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.code === 0) {
      logger.info(`🔁 [auto-rename] ${folderPath} → ${platform}/${id} 成功`);
    } else {
      logger.warn(`🔁 [auto-rename] ${folderPath} → ${platform}/${id} 失败: ${json.message}`);
    }
  } catch (err) {
    logger.warn(`🔁 [auto-rename] ${folderPath} 请求异常: ${err.message}`);
  }
}

function scheduleRename(folderPath) {
  if (pending.has(folderPath)) {
    clearTimeout(pending.get(folderPath));
  }
  pending.set(folderPath, setTimeout(() => {
    pending.delete(folderPath);
    try {
      const files = scanVideos(folderPath);
      if (files.length === 0) return;
      const result = detectPlatformAndID(files);
      if (!result) return;
      triggerRename(folderPath, result.platform, result.id);
    } catch (err) {
      logger.debug(`[auto-rename] scan error ${folderPath}: ${err.message}`);
    }
  }, 5000)); // 5s debounce
}

function start() {
  if (!fs.existsSync(FOLDERS_BASE)) {
    logger.warn(`[auto-rename] FOLDERS_BASE 不存在: ${FOLDERS_BASE}`);
    return;
  }

  // Watch all existing subdirectories
  const entries = fs.readdirSync(FOLDERS_BASE, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(FOLDERS_BASE, e.name);
    try {
      fs.watch(dirPath, { persistent: false }, (_eventType, fileName) => {
        if (!fileName || !isVideoExt(fileName)) return;
        scheduleRename(dirPath);
      });
      logger.info(`👀 [auto-rename] 监听: ${dirPath}`);
    } catch (err) {
      logger.debug(`[auto-rename] 无法监听 ${dirPath}: ${err.message}`);
    }
  }

  // Also watch FOLDERS_BASE for new subdirectories
  fs.watch(FOLDERS_BASE, { persistent: false }, (_eventType, name) => {
    if (!name) return;
    const dirPath = path.join(FOLDERS_BASE, name);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
    try {
      fs.watch(dirPath, { persistent: false }, (_ev, fileName) => {
        if (!fileName || !isVideoExt(fileName)) return;
        scheduleRename(dirPath);
      });
      logger.info(`👀 [auto-rename] 新增监听: ${dirPath}`);
    } catch {}
  });

  // 初始扫描：已存在的目录也检查一遍
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    scheduleRename(path.join(FOLDERS_BASE, e.name));
  }

  logger.info('⚡ [auto-rename] 启动完成');
}

module.exports = { start };
