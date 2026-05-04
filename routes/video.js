const fs = require('fs');
const path = require('path');
const { success, fail } = require('../utils/response');
const { decodeSafe, resolveExistingVideoPath, isVideoExt, scanVideos, getThumbPath } = require('../utils/file');
const { detectVideoIdFromName } = require('../utils/video');
const { fetchBiliCover, downloadImage } = require('../services/bilibili');
const { streamDirect, transcodeStream, generateLocalThumb } = require('../services/ffmpeg');
const logger = require('../utils/logger');
const { THUMB_DIR, FOLDERS_BASE } = require('../shared/constants');
const state = require('../shared/state');
const { resolveLibraryDirectory, isPathValidationError } = require('../shared/helpers');

const router = require('express').Router();

// GET /api/videos
router.get('/videos', (req, res) => {
  try {
    logger.debug('VIDEO_DIR:', state.videoDir);
    const files = scanVideos(state.videoDir);
    files.sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    );
    res.json(success(files));
  } catch (err) {
    logger.error(err);
    res.status(500).json(fail(500, '无法读取文件列表'));
  }
});

// PUT /api/config
router.put('/config', (req, res) => {
  try {
    const { videoDir } = req.body;
    if (!videoDir || typeof videoDir !== 'string') {
      return res.status(400).json(fail(400, '缺少 videoDir 参数'));
    }
    const resolved = resolveLibraryDirectory(videoDir);
    state.videoDir = resolved;
    logger.info('VIDEO_DIR updated to:', state.videoDir);
    res.json(success({ videoDir: state.videoDir }));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, status === 400 ? err.message : '更新配置失败'));
  }
});

// GET /api/thumbnail
router.get('/thumbnail', async (req, res) => {
  try {
    const fileName = req.query.name || req.query.file;
    if (!fileName) return res.status(400).send('缺少文件名');

    const safeName = decodeSafe(fileName);
    const videoPath = resolveExistingVideoPath(safeName, state.videoDir);
    const thumbPath = getThumbPath(safeName, THUMB_DIR);

    if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

    const videoId = detectVideoIdFromName(safeName);
    if (videoId) {
      try {
        const coverUrl = await fetchBiliCover(videoId);
        logger.debug('尝试获取B站封面，视频ID:', videoId, '封面URL:', coverUrl);
        if (coverUrl) {
          await downloadImage(coverUrl, thumbPath);
          if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);
        }
      } catch (e) {
        logger.debug('B站封面获取失败，回退本地截图');
      }
    }

    await generateLocalThumb(videoPath, thumbPath);

    if (!fs.existsSync(thumbPath)) {
      return res.status(500).send('缩略图生成失败');
    }
    res.sendFile(thumbPath);
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).send(status === 400 ? err.message : '缩略图失败');
  }
});

// GET /video/:name
router.get('/video/:name', (req, res) => {
  try {
    const fileName = decodeSafe(req.params.name);
    const videoPath = resolveExistingVideoPath(fileName, state.videoDir);
    streamDirect(videoPath, req, res);
  } catch (err) {
    if (!isPathValidationError(err)) logger.error(err);
    res.status(400).send('非法请求');
  }
});

// GET /stream
router.get('/stream', (req, res) => {
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

module.exports = router;
