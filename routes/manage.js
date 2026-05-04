const fs = require('fs');
const path = require('path');
const { success, fail } = require('../utils/response');
const { isPathInside, resolvePathInside, isVideoExt } = require('../utils/file');
const logger = require('../utils/logger');
const { FOLDERS_BASE, RETENTION_CONFIG_FILE } = require('../shared/constants');
const {
  resolveLibraryDirectory,
  resolveLibraryVideoFile,
  isPathValidationError,
  scanVideoFiles
} = require('../shared/helpers');

const router = require('express').Router();

// GET /api/manage/videos
router.get('/manage/videos', (req, res) => {
  try {
    const folder = req.query.folder;
    let files;
    if (folder) {
      const resolved = resolveLibraryDirectory(folder);
      files = [];
      let entries;
      try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isFile() || !isVideoExt(entry.name)) continue;
        const fp = path.join(resolved, entry.name);
        const stat = fs.statSync(fp);
        files.push({ name: entry.name, path: fp, size: stat.size, mtime: stat.mtimeMs, folder: path.relative(FOLDERS_BASE, resolved) || '' });
      }
    } else {
      files = scanVideoFiles(FOLDERS_BASE).map(f => {
        const stat = fs.statSync(f.path);
        return { name: f.name.split(path.sep).pop(), path: f.path, size: stat.size, mtime: stat.mtimeMs, folder: path.relative(FOLDERS_BASE, path.dirname(f.path)) || '' };
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    res.json(success(files));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, status === 400 ? err.message : '读取视频列表失败'));
  }
});

// DELETE /api/manage/video
router.delete('/manage/video', (req, res) => {
  try {
    const filePath = req.body.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json(fail(400, '缺少 path 参数'));
    }
    const resolved = resolveLibraryVideoFile(filePath);
    fs.unlinkSync(resolved);
    logger.info(`🗑️  [manage] 删除视频: ${resolved}`);
    res.json(success(null, '删除成功'));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, err.message));
  }
});

// GET /api/manage/retention
router.get('/manage/retention', (_req, res) => {
  try {
    if (!fs.existsSync(RETENTION_CONFIG_FILE)) return res.json(success({ folders: {} }));
    res.json(success(JSON.parse(fs.readFileSync(RETENTION_CONFIG_FILE, 'utf-8'))));
  } catch {
    res.json(success({ folders: {} }));
  }
});

// PUT /api/manage/retention
router.put('/manage/retention', (req, res) => {
  try {
    const { type, folder, file: filePath, path: filePathAlt, days } = req.body || {};
    const targetPath = folder || filePath || filePathAlt;
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json(fail(400, '缺少 folder/path 参数'));
    }
    if (typeof days !== 'number' || days < 0 || !Number.isInteger(days)) {
      return res.status(400).json(fail(400, 'days 必须是非负整数'));
    }
    const isFile = type === 'file' || (filePath || filePathAlt);
    const resolved = days === 0
      ? resolvePathInside(targetPath, FOLDERS_BASE)
      : (isFile ? resolveLibraryVideoFile(targetPath) : resolveLibraryDirectory(targetPath));
    let config = { folders: {}, files: {} };
    if (fs.existsSync(RETENTION_CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(RETENTION_CONFIG_FILE, 'utf-8'));
    }

    if (isFile) {
      if (!config.files) config.files = {};
      if (days === 0) delete config.files[resolved];
      else config.files[resolved] = { days, setAt: Date.now() };
    } else {
      if (!config.folders) config.folders = {};
      if (days === 0) delete config.folders[resolved];
      else config.folders[resolved] = { days, setAt: Date.now() };
    }

    fs.writeFileSync(RETENTION_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json(success(config));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    res.status(status).json(fail(status, err.message));
  }
});

module.exports = router;
