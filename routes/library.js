const fs = require('fs');
const path = require('path');
const { success, fail } = require('../utils/response');
const { isVideoExt } = require('../utils/file');
const { sanitizeFileName, extractEpisodeNumberFromFileName, extractEpId } = require('../utils/video');
const { fetchSeasonInfo } = require('../services/bilibili');
const axios = require('axios');
const logger = require('../utils/logger');
const { FOLDERS_BASE } = require('../shared/constants');
const {
  resolveLibraryDirectory,
  isPathValidationError,
  scanFolders,
  hasDirectVideoFiles,
  scanVideoFiles
} = require('../shared/helpers');

const router = require('express').Router();

// GET /api/folders
router.get('/folders', (req, res) => {
  try {
    const allFolders = scanFolders(FOLDERS_BASE);
    const folders = [{ path: FOLDERS_BASE, name: '(根目录)' }]
      .concat(allFolders.filter(f => hasDirectVideoFiles(f.path)));
    res.json(success(folders));
  } catch (err) {
    logger.error(err);
    res.status(500).json(fail(500, '读取文件夹列表失败'));
  }
});

// GET /api/video-files
router.get('/video-files', (req, res) => {
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
        files.push({ path: path.join(resolved, entry.name), name: entry.name });
      }
    } else {
      files = scanVideoFiles(FOLDERS_BASE);
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    res.json(success(files));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, status === 400 ? err.message : '读取文件列表失败'));
  }
});

// POST /api/rename
router.post('/rename', async (req, res) => {
  try {
    const { folderPath, biliUrl } = req.body || {};
    if (!folderPath || !biliUrl) {
      return res.status(400).json(fail(400, '缺少文件夹路径或B站链接'));
    }

    const safeFolderPath = resolveLibraryDirectory(folderPath);
    const epId = extractEpId(biliUrl);
    if (!epId) return res.status(400).json(fail(400, '无法识别EP号'));

    const season = await fetchSeasonInfo(epId);
    const seasonTitle = sanitizeFileName(season.title);
    const episodes = (season.episodes || []).slice().sort((a, b) => {
      return Number(a?.title || 0) - Number(b?.title || 0);
    });

    const videoFiles = fs.readdirSync(safeFolderPath)
      .filter(file => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(file))
      .sort();

    if (videoFiles.length === 0) {
      return res.status(400).json(fail(400, '文件夹内没有视频文件'));
    }

    const renamedFiles = [];
    const usedEpisodeIds = new Set();

    videoFiles.forEach((file, index) => {
      const detectedEpisodeNumber = extractEpisodeNumberFromFileName(file);
      let ep = null;
      if (detectedEpisodeNumber != null) {
        ep = episodes.find(item => Number(item?.title || 0) === detectedEpisodeNumber);
      }
      if (!ep) ep = episodes[index];
      if (!ep || usedEpisodeIds.has(ep.id)) return;

      const ext = path.extname(file);
      const episodeNumber = String(
        detectedEpisodeNumber != null ? detectedEpisodeNumber : Number(ep.title || index + 1)
      ).padStart(2, '0');
      const newName = `EP${episodeNumber}_${seasonTitle}_ep${ep.id}${ext}`;

      fs.renameSync(path.join(safeFolderPath, file), path.join(safeFolderPath, newName));
      usedEpisodeIds.add(ep.id);

      renamedFiles.push({
        oldName: file,
        newName,
        matchedEpisode: Number(ep.title || episodeNumber),
        matchedEpId: ep.id
      });
    });

    fs.writeFileSync(path.join(safeFolderPath, 'mapping.json'), JSON.stringify(renamedFiles, null, 2));
    res.json(success({ seasonTitle, totalFiles: renamedFiles.length, renamedFiles }));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, err.message || '重命名失败'));
  }
});

// POST /api/rename/iqiyi
router.post('/rename/iqiyi', async (req, res) => {
  try {
    const { folderPath, tvid } = req.body || {};
    if (!folderPath || !tvid) return res.status(400).json(fail(400, '缺少文件夹路径或 tvid'));

    const safeFolder = resolveLibraryDirectory(folderPath);

    // 查 albumId
    const infoUrl = `https://pcw-api.iqiyi.com/video/video/baseinfo/${tvid}`;
    const infoResp = await axios.get(infoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const albumId = infoResp.data?.data?.albumId;
    if (!albumId) return res.status(400).json(fail(400, '未找到 albumId'));

    // 查整季列表
    const albumUrl = `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${albumId}&page=1&size=50`;
    const albumResp = await axios.get(albumUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    const episodes = albumResp.data?.data?.epsodelist || [];

    // order → tvId 映射
    const epMap = {};
    for (const ep of episodes) {
      epMap[Number(ep.order)] = String(ep.tvId || '');
    }
    logger.info(`[iqiyi-rename] albumId=${albumId} ${episodes.length}集`);

    // 扫描文件夹
    const videoExts = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);
    const files = fs.readdirSync(safeFolder).filter(f => videoExts.has(path.extname(f).toLowerCase()));

    const renamedFiles = [];
    for (const fname of files) {
      const ext = path.extname(fname);
      const base = path.basename(fname, ext);

      // 已含 tvid（9-16 位数字），跳过
      if (/\d{9,16}/.test(base)) continue;

      const epNum = extractEpisodeNumberFromFileName(fname);
      if (epNum == null || !epMap[epNum]) continue;

      const tvId = epMap[epNum];
      const newName = `${base}_${tvId}${ext}`;
      fs.renameSync(path.join(safeFolder, fname), path.join(safeFolder, newName));
      renamedFiles.push({ oldName: fname, newName, episode: epNum, tvId });
    }

    res.json(success({ albumId, totalEpisodes: episodes.length, renamedFiles }));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, err.message || '重命名失败'));
  }
});

module.exports = router;
