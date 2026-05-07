const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// 命令行参数覆盖日志级别: node server.js --debug | --info | --warn | --error | --silent
const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
const cliLevel = process.argv.find(a => a.startsWith('--') && LOG_LEVELS.includes(a.slice(2)));
if (cliLevel) process.env.LOG_LEVEL = cliLevel.slice(2);

const logger = require('./utils/logger');
const { CACHE_DIRS, PLAYBACK_DIR, THUMB_DIR, META_DIR, CONVERT_HISTORY_FILE, RETENTION_CONFIG_FILE, FOLDERS_BASE, PLAYBACK_MAX_AGE } = require('./shared/constants');
const { isPathInside, isVideoExt, decodeSafe, resolveExistingVideoPath } = require('./utils/file');
const { resolveLibraryDirectory, resolveLibraryVideoFile, isPathValidationError } = require('./shared/helpers');
const { streamDirect, transcodeStream } = require('./services/ffmpeg');
const state = require('./shared/state');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 初始化缓存目录
for (const dir of CACHE_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 恢复中断的转换任务（服务器重启后标记为 interrupted）
if (fs.existsSync(CONVERT_HISTORY_FILE)) {
  try {
    const history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
    let changed = false;
    for (const t of history) {
      if (t.status === 'running' || t.status === 'probing') {
        t.status = 'interrupted';
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(CONVERT_HISTORY_FILE, JSON.stringify(history, null, 2));
      logger.info('[convert] 标记了中断的转换任务');
    }
  } catch {}
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 静态页面重定向
app.get('/', (_req, res) => res.redirect('/index.html'));
app.get('/ipad', (_req, res) => res.redirect('/ipad.html'));
app.get('/manage', (_req, res) => res.redirect('/manage.html'));
app.get('/rename', (_req, res) => res.redirect('/rename.html'));
app.get('/library', (_req, res) => res.redirect('/library.html'));

// 视频流直链（非 API，挂载在根路径）
app.get('/video/:name', (req, res) => {
  try {
    const fileName = decodeSafe(req.params.name);
    const videoPath = resolveExistingVideoPath(fileName, state.videoDir);
    streamDirect(videoPath, req, res);
  } catch (err) {
    if (!isPathValidationError(err)) logger.error(err);
    res.status(400).send('非法请求');
  }
});

app.get('/stream', (req, res) => {
  try {
    const fileName = decodeSafe(String(req.query.name || ''));
    if (!fileName) return res.status(400).send('缺少文件名');
    const videoPath = resolveExistingVideoPath(fileName, state.videoDir);
    logger.debug('Streaming video:', videoPath);
    const ext = path.extname(videoPath).toLowerCase();
    const directPlayable = new Set(['.mp4', '.mov', '.webm', '.m4v']);
    if (directPlayable.has(ext)) return streamDirect(videoPath, req, res);
    return transcodeStream(videoPath, req, res);
  } catch (err) {
    if (!isPathValidationError(err)) logger.error(err);
    res.status(400).send('非法请求');
  }
});

// 挂载路由模块
app.use('/api', require('./routes/danmaku'));
app.use('/api', require('./routes/video'));
app.use('/api', require('./routes/library'));
app.use('/api', require('./routes/progress'));
app.use('/api', require('./routes/convert'));
app.use('/api', require('./routes/library_info'));
app.use('/api', require('./routes/manage'));
app.use('/api', require('./routes/config'));

// ==================== 定时清理任务 ====================

function cleanupVideos() {
  try {
    if (!fs.existsSync(RETENTION_CONFIG_FILE)) return;
    const config = JSON.parse(fs.readFileSync(RETENTION_CONFIG_FILE, 'utf-8'));
    const now = Date.now();
    let totalDeleted = 0;
    let configChanged = false;

    const folders = config.folders || {};
    for (const [folderPath, rule] of Object.entries(folders)) {
      let safeFolderPath;
      try { safeFolderPath = resolveLibraryDirectory(folderPath); } catch {
        if (fs.existsSync(folderPath)) { delete config.folders[folderPath]; configChanged = true; logger.warn(`🧹 [auto-cleanup] 移除非法规则(目录): ${folderPath}`); }
        continue;
      }
      if (!isPathInside(safeFolderPath, FOLDERS_BASE)) { delete config.folders[folderPath]; configChanged = true; logger.warn(`🧹 [auto-cleanup] 移除越界规则(目录): ${folderPath}`); continue; }
      const keepDays = typeof rule === 'number' ? rule : (rule.days || 0);
      const setAt = typeof rule === 'number' ? 0 : (rule.setAt || 0);
      if (!keepDays || keepDays <= 0) continue;
      const maxAge = keepDays * 86400000;
      let entries;
      try { entries = fs.readdirSync(safeFolderPath, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !isVideoExt(entry.name)) continue;
        const fp = path.join(safeFolderPath, entry.name);
        try {
          const stat = fs.statSync(fp);
          if (now > (setAt > 0 ? setAt + maxAge : stat.mtimeMs + maxAge)) { fs.unlinkSync(fp); totalDeleted++; logger.info(`🗑️  [auto-cleanup] 删除过期视频: ${fp}`); }
        } catch {}
      }
    }

    const files = config.files || {};
    for (const [filePath, rule] of Object.entries(files)) {
      let safeFilePath;
      try { safeFilePath = resolveLibraryVideoFile(filePath); } catch {
        if (fs.existsSync(filePath)) { delete config.files[filePath]; configChanged = true; logger.warn(`🧹 [auto-cleanup] 移除非法规则(文件): ${filePath}`); }
        continue;
      }
      if (!isPathInside(safeFilePath, FOLDERS_BASE)) { delete config.files[filePath]; configChanged = true; logger.warn(`🧹 [auto-cleanup] 移除越界规则(文件): ${filePath}`); continue; }
      const keepDays = typeof rule === 'number' ? rule : (rule.days || 0);
      if (!keepDays || keepDays <= 0) continue;
      const setAt = typeof rule === 'number' ? 0 : (rule.setAt || 0);
      const fileMaxAge = keepDays * 86400000;
      try {
        const stat = fs.statSync(safeFilePath);
        if (now > (setAt > 0 ? setAt + fileMaxAge : stat.mtimeMs + fileMaxAge)) { fs.unlinkSync(safeFilePath); totalDeleted++; logger.info(`🗑️  [auto-cleanup] 删除过期视频(单独): ${safeFilePath}`); }
      } catch {}
    }

    for (const fp of Object.keys(config.files || {})) {
      if (!fs.existsSync(fp)) { delete config.files[fp]; configChanged = true; logger.info(`🧹 [auto-cleanup] 移除无效规则(文件已删): ${fp}`); }
    }
    for (const fp of Object.keys(config.folders || {})) {
      if (!fs.existsSync(fp)) { delete config.folders[fp]; configChanged = true; logger.info(`🧹 [auto-cleanup] 移除无效规则(目录已删): ${fp}`); }
    }
    if (configChanged) fs.writeFileSync(RETENTION_CONFIG_FILE, JSON.stringify(config, null, 2));
    if (totalDeleted > 0) logger.info(`🗑️  [auto-cleanup] 本轮共清理 ${totalDeleted} 个过期视频`);
  } catch (err) {
    logger.error('[auto-cleanup] 清理出错:', err.message);
  }
}

function cleanupPlayback() {
  if (!fs.existsSync(PLAYBACK_DIR)) return;
  const now = Date.now();
  let count = 0;
  fs.readdirSync(PLAYBACK_DIR).forEach(f => {
    const file = path.join(PLAYBACK_DIR, f);
    try { if (now - fs.statSync(file).mtimeMs > PLAYBACK_MAX_AGE) { fs.unlinkSync(file); count++; } } catch {}
  });
  if (count > 0) logger.info(`🗑️  自动清理 ${count} 个过期播放记录`);
}

cleanupVideos();
setInterval(cleanupVideos, 3600000);
cleanupPlayback();
setInterval(cleanupPlayback, 3600000);

// ==================== 启动 ====================

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith('192.168.')) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const localIP = getLocalIP();
app.listen(PORT, '0.0.0.0', () => {
  logger.info('服务器已在局域网启动！');
  logger.info(`本机请访问: http://localhost:${PORT}/video.html`);
  logger.info(`iPad访问: http://${localIP}:${PORT}/video.html`);
});
