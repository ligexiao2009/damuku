const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
require('dotenv').config();

const { success, fail } = require('./utils/response');
const { decodeSafe, resolveVideoPath, isVideoExt, scanVideos, getCacheFilePaths, getThumbPath } = require('./utils/file');
const { detectVideoIdFromName, sanitizeFileName, extractEpisodeNumberFromFileName, extractEpId } = require('./utils/video');
const { fetchVideoMeta, fetchSeasonInfo, fetchDanmuXml, fetchDanmuSeg, fetchBiliCover, downloadImage } = require('./services/bilibili');
const { parseDanmu, tryParseDanmuSeg } = require('./services/danmu');
const { fetchTencentDanmaku } = require('./services/tencent');
const { fetchMangoDanmaku } = require('./services/mango');
const { fetchZhibo8Danmaku } = require('./services/zhibo8');
const { fetchTxspDanmaku } = require('./services/txsp');
const { streamDirect, transcodeStream, generateLocalThumb } = require('./services/ffmpeg');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const BASE_DIR = process.env.CACHE_BASE || __dirname;
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const PLAYBACK_DIR = path.join(BASE_DIR, 'playback');
const DANMU_DIR = process.env.DANMU_CACHE_DIR || path.join(CACHE_DIR, 'danmu');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_DIR = path.join(CACHE_DIR, 'meta');
const CONVERT_HISTORY_FILE = path.join(CACHE_DIR, 'convert_history.json');
const FOLDER_HISTORY_FILE = path.join(CACHE_DIR, 'folder_history.json');
const OVERLAY_CONFIG_FILE = path.join(CACHE_DIR, 'overlay_config.json');
let VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
const danmuProgressMap = new Map();
const convertTasks = new Map();

// 备份弹幕缓存文件（精确到分钟的时间戳）
function backupCache(filePath) {
  if (!fs.existsSync(filePath)) return;
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const bak = `${filePath}.bak.${ts}`;
  fs.copyFileSync(filePath, bak);
  console.log(`📦 备份旧缓存: ${path.basename(bak)}`);
}


for (const dir of [CACHE_DIR, PLAYBACK_DIR, DANMU_DIR, THUMB_DIR, META_DIR]) {
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
      console.log('[convert] 标记了中断的转换任务');
    }
  } catch {}
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 本地工具函数 ====================

/** 获取本机局域网 IP 地址（192.168.x.x），未找到返回 'localhost'。 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (
        net.family === 'IPv4' &&
        !net.internal &&
        net.address.startsWith('192.168.')
      ) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

/** 将转换任务记录写入历史文件（最多保留 50 条）。 */
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
    console.error('保存转换历史失败:', err.message);
  }
}

const FOLDERS_BASE = process.env.FOLDERS_BASE || path.join(os.homedir(), 'video');

/** 递归扫描目录下所有子文件夹，返回 { path, name } 数组。 */
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
    results.push({
      path: path.join(baseDir, rel),
      name: rel
    });
    results = results.concat(scanFolders(baseDir, rel));
  }
  return results;
}

/** 检查目录下是否直接包含视频文件（不递归）。 */
function hasDirectVideoFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).some(e => e.isFile() && isVideoExt(e.name));
  } catch {
    return false;
  }
}

/** 递归扫描目录下所有视频文件，返回 { path, name } 数组。 */
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

// ==================== API routes ====================

app.get('/api/danmu/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少视频ID'));
  const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
  const progress = danmuProgressMap.get(cacheKey);
  res.json(success(progress || null));
});

app.get('/api/danmu', async (req, res) => {
  let cacheKey;
  try {
    const { id } = req.query;
    const requestedStrategy = req.query.strategy === 'seg.so' ? 'seg.so' : 'xml';
    const forceRefresh = req.query.refresh === '1';

    if (!id) return res.status(400).json(fail(400, '缺少视频ID'));
    cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
    const [cacheFile] = getCacheFilePaths(cacheKey, requestedStrategy, DANMU_DIR);

    if (!forceRefresh && fs.existsSync(cacheFile)) {
      return res.json(success({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true }));
    }
    console.log('Fetching danmu for ID:', id, 'Strategy:', requestedStrategy, 'Force Refresh:', forceRefresh);
    const videoMeta = await fetchVideoMeta(id, META_DIR);

    let danmus = [];
    let strategy = requestedStrategy;

    if (requestedStrategy === 'seg.so') {
      const segmentCount = Math.min(100, Math.max(1, Math.ceil((videoMeta.duration || 0) / 360)));
      console.log(`[seg.so] 开始加载弹幕，共 ${segmentCount} 个分段...`);
      console.time('[seg.so] 耗时');

      danmuProgressMap.set(cacheKey, { current: 0, total: segmentCount, phase: 'loading' });

      const results = [];
      for (let i = 1; i <= segmentCount; i++) {
        try {
          const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: i });
          results[i - 1] = { status: 'fulfilled', value: buf };
        } catch (err) {
          results[i - 1] = { status: 'rejected', reason: err };
        }
        danmuProgressMap.set(cacheKey, { current: i, total: segmentCount, phase: 'loading' });
        if (i < segmentCount) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      danmus = [];
      const retryIndices = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const parsed = tryParseDanmuSeg(r.value, i + 1);
          if (parsed.length) {
            danmus.push(...parsed);
          } else {
            retryIndices.push(i + 1);
          }
        } else {
          retryIndices.push(i + 1);
        }
      });

      if (retryIndices.length) {
        danmuProgressMap.set(cacheKey, { current: 0, total: retryIndices.length, phase: 'retrying' });
        console.log(`[seg.so] ${retryIndices.length} 个分段失败，等待5秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        for (const idx of retryIndices) {
          try {
            const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: idx });
            const parsed = tryParseDanmuSeg(buf, idx);
            if (parsed.length) {
              danmus.push(...parsed);
              console.log(`[seg.so] 分段 ${idx} 重试成功，${parsed.length} 条`);
            } else {
              console.log(`[seg.so] 分段 ${idx} 重试仍然失败，已放弃`);
            }
          } catch (err) {
            const retryDetail = err.response ? ` status=${err.response.status} body=${Buffer.from(err.response.data || '').toString('utf-8').slice(0, 200)}` : '';
            console.log(`[seg.so] 分段 ${idx} 重试异常: ${err.message}${retryDetail}`);
          }
          danmuProgressMap.set(cacheKey, { current: retryIndices.indexOf(idx) + 1, total: retryIndices.length, phase: 'retrying' });
          if (idx < retryIndices[retryIndices.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      danmuProgressMap.delete(cacheKey);
      console.timeEnd('[seg.so] 耗时');
      console.log(`[seg.so] 加载完成，共 ${danmus.length} 条弹幕`);
    } else {
      console.time('[xml] 耗时');
      const xml = await fetchDanmuXml(videoMeta.cid);
      danmus = parseDanmu(xml);
      console.timeEnd('[xml] 耗时');
      console.log(`[xml] 加载完成，共 ${danmus.length} 条弹幕`);
    }

    const cacheFileFinal = getCacheFilePaths(cacheKey, strategy, DANMU_DIR)[0];
    const result = { strategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
    backupCache(cacheFileFinal);
    fs.writeFileSync(cacheFileFinal, JSON.stringify(result, null, 2));
    res.json(success(result));
  } catch (err) {
    danmuProgressMap.delete(cacheKey);
    res.status(500).json(fail(500, err.message));
  }
});

// ==================== Unified Danmaku API ====================

app.get('/api/danmaku', async (req, res) => {
  try {
    const { source, id, duration } = req.query;
    if (!source) return res.status(400).json(fail(400, '缺少 source 参数'));

    // 腾讯弹幕
    if (source === 'qq') {
      const vid = id;
      const durMs = Number(duration) || 3600000;
      const forceRefresh = req.query.refresh === '1';
      const cacheFile = path.join(DANMU_DIR, `qq_${vid}.json`);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        return res.json(success({ ...cached, fromCache: true }));
      }

      console.log(`[tencent] 抓取弹幕 VID: ${vid} 时长: ${(durMs / 60000).toFixed(1)}分钟`);
      console.time('[tencent] 耗时');
      const danmus = await fetchTencentDanmaku(vid, durMs);
      console.timeEnd('[tencent] 耗时');
      console.log(`[tencent] 完成，共 ${danmus.length} 条`);

      const result = { source: 'qq', id: vid, count: danmus.length, danmus };
      backupCache(cacheFile);
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // B站弹幕
    if (source === 'bili') {
      const requestedStrategy = req.query.strategy === 'xml' ? 'xml' : 'seg.so';
      const forceRefresh = req.query.refresh === '1';
      const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
      const [cacheFile] = getCacheFilePaths(cacheKey, requestedStrategy, DANMU_DIR);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        return res.json(success({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true }));
      }

      console.log('Fetching danmu for ID:', id, 'Strategy:', requestedStrategy);
      const videoMeta = await fetchVideoMeta(id, META_DIR);
      let danmus = [];

      if (requestedStrategy === 'seg.so') {
        const segmentCount = Math.min(100, Math.max(1, Math.ceil((videoMeta.duration || 0) / 360)));
        console.log(`[seg.so] 开始加载，共 ${segmentCount} 分段...`);
        console.time('[seg.so] 耗时');

        danmuProgressMap.set(cacheKey, { current: 0, total: segmentCount, phase: 'loading' });

        const results = [];
        for (let i = 1; i <= segmentCount; i++) {
          try {
            const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: i });
            results[i - 1] = { status: 'fulfilled', value: buf };
          } catch (err) {
            results[i - 1] = { status: 'rejected', reason: err };
          }
          danmuProgressMap.set(cacheKey, { current: i, total: segmentCount, phase: 'loading' });
          if (i < segmentCount) await new Promise(r => setTimeout(r, 2000));
        }

        danmus = [];
        const retryIndices = [];
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            const parsed = tryParseDanmuSeg(r.value, i + 1);
            if (parsed.length) danmus.push(...parsed);
            else retryIndices.push(i + 1);
          } else {
            retryIndices.push(i + 1);
          }
        });

        if (retryIndices.length) {
          danmuProgressMap.set(cacheKey, { current: 0, total: retryIndices.length, phase: 'retrying' });
          console.log(`[seg.so] ${retryIndices.length} 分段失败，5秒后重试...`);
          await new Promise(r => setTimeout(r, 5000));
          for (const idx of retryIndices) {
            try {
              const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: idx });
              const parsed = tryParseDanmuSeg(buf, idx);
              if (parsed.length) danmus.push(...parsed);
            } catch (err) {}
            danmuProgressMap.set(cacheKey, { current: retryIndices.indexOf(idx) + 1, total: retryIndices.length, phase: 'retrying' });
            if (idx < retryIndices[retryIndices.length - 1]) await new Promise(r => setTimeout(r, 2000));
          }
        }

        danmuProgressMap.delete(cacheKey);
        console.timeEnd('[seg.so] 耗时');
        console.log(`[seg.so] 完成，共 ${danmus.length} 条`);
      } else {
        console.time('[xml] 耗时');
        const xml = await fetchDanmuXml(videoMeta.cid);
        danmus = parseDanmu(xml);
        console.timeEnd('[xml] 耗时');
        console.log(`[xml] 完成，共 ${danmus.length} 条`);
      }

      const cacheFileFinal = getCacheFilePaths(cacheKey, requestedStrategy, DANMU_DIR)[0];
      const result = { source: 'bili', strategy: requestedStrategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
      backupCache(cacheFileFinal);
      fs.writeFileSync(cacheFileFinal, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // 芒果TV弹幕
    if (source === 'mango') {
      const parts = id.split('/');
      const timeStr = parts[0] || '000000';
      const videoId = parts[1] || id;
      const forceRefresh = req.query.refresh === '1';
      const cacheFile = path.join(DANMU_DIR, `mango_${timeStr}_${videoId}.json`);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        return res.json(success({ ...cached, fromCache: true }));
      }

      console.log(`[mango] 抓取弹幕 videoId: ${videoId} time: ${timeStr}`);
      console.time('[mango] 耗时');
      const danmus = await fetchMangoDanmaku(videoId, undefined, timeStr);
      console.timeEnd('[mango] 耗时');

      const result = { source: 'mango', id: videoId, count: danmus.length, danmus };
      backupCache(cacheFile);
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // 直播吧弹幕（实时轮询）
    if (source === 'zhibo8') {
      const matchId = (id || '');
      const type = req.query.type || 'zuqiu';
      const lastMaxId = Number(req.query.lastMaxId) || 0;
      console.log(`[zhibo8] 查询弹幕 matchId: ${matchId} type: ${type} lastMaxId: ${lastMaxId}`);
      const { danmus, maxId } = await fetchZhibo8Danmaku(matchId, type, lastMaxId);
      return res.json(success({ source: 'zhibo8', id: matchId, count: danmus.length, danmus, maxId }));
    }

    // 腾讯体育弹幕（实时轮询）
    if (source === 'txsp') {
      const roomId = req.query.roomId || '';
      const programId = req.query.programId || '';
      const lastSeq = Number(req.query.lastSeq) || 0;
      const cursor = req.query.cursor || '';
      if (!roomId || !programId) return res.status(400).json(fail(400, '缺少 roomId 或 programId'));
      console.log(`[txsp] 查询弹幕 roomId: ${roomId} programId: ${programId} lastSeq: ${lastSeq}`);
      const txspCookie = req.query.txspCookie || '';
      const { danmus, maxSeq, cursor: nextCursor, pullInterval } = await fetchTxspDanmaku(roomId, programId, lastSeq, cursor, txspCookie);
      return res.json(success({ source: 'txsp', id: `${roomId}_${programId}`, count: danmus.length, danmus, maxSeq, cursor: nextCursor, pullInterval }));
    }

    return res.status(400).json(fail(400, '不支持的弹幕源，可选: bili, qq, mango, zhibo8, txsp'));
  } catch (err) {
    console.error(`[${req.query.source}] 弹幕请求失败:`, err.message);
    const { id, source } = req.query;
    if (source === 'bili') {
      const ck = (id || '').toUpperCase().startsWith('BV') ? id : `ep${String(id || '').replace(/^ep/i, '')}`;
      danmuProgressMap.delete(ck);
    }
    res.status(500).json(fail(500, err.message));
  }
});

// ==================== Overlay Config API ====================

app.get('/api/overlay-config', (req, res) => {
  try {
    const defaults = { offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 };
    const maxDuration = Number(process.env.DANMAKU_MAX_DURATION) || 10800;
    let config = defaults;
    if (fs.existsSync(OVERLAY_CONFIG_FILE)) {
      config = { ...defaults, ...JSON.parse(fs.readFileSync(OVERLAY_CONFIG_FILE, 'utf-8')) };
    }
    res.json(success({ ...config, maxDuration }));
  } catch {
    res.json(success({ offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25, maxDuration: 10800 }));
  }
});

app.put('/api/overlay-config', (req, res) => {
  try {
    const defaults = { offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 };
    const config = { ...defaults, ...req.body };
    fs.writeFileSync(OVERLAY_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json(success(config));
  } catch (err) {
    res.status(500).json(fail(500, err.message));
  }
});

app.get('/api/folder-history', (req, res) => {
  try {
    if (!fs.existsSync(FOLDER_HISTORY_FILE)) return res.json(success({}));
    res.json(success(JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8'))));
  } catch (err) {
    res.json(success({}));
  }
});

app.put('/api/folder-history', (req, res) => {
  try {
    const { dir, name } = req.body;
    if (!dir || name == null) return res.status(400).json(fail(400, '缺少参数'));
    let history = {};
    if (fs.existsSync(FOLDER_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8'));
    }
    history[dir] = name;
    fs.writeFileSync(FOLDER_HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json(success(null));
  } catch (err) {
    res.status(500).json(fail(500, err.message));
  }
});

app.get('/api/videos', (req, res) => {
  try {
    console.log('VIDEO_DIR:', VIDEO_DIR);
    const files = scanVideos(VIDEO_DIR);
    files.sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    );
    res.json(success(files));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, '无法读取文件列表'));
  }
});

app.put('/api/config', (req, res) => {
  try {
    const { videoDir } = req.body;
    if (!videoDir || typeof videoDir !== 'string') {
      return res.status(400).json(fail(400, '缺少 videoDir 参数'));
    }
    const resolved = path.resolve(videoDir);
    if (!fs.existsSync(resolved)) {
      return res.status(400).json(fail(400, `目录不存在: ${resolved}`));
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return res.status(400).json(fail(400, `路径不是目录: ${resolved}`));
    }
    VIDEO_DIR = resolved;
    console.log('VIDEO_DIR updated to:', VIDEO_DIR);
    res.json(success({ videoDir: VIDEO_DIR }));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, '更新配置失败'));
  }
});

app.get('/api/folders', (req, res) => {
  try {
    const allFolders = scanFolders(FOLDERS_BASE);
    // 只保留直接包含视频文件的目录（不递归子目录）
    const folders = [{ path: FOLDERS_BASE, name: '(根目录)' }]
      .concat(allFolders.filter(f => hasDirectVideoFiles(f.path)));
    res.json(success(folders));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, '读取文件夹列表失败'));
  }
});

app.get('/api/video-files', (req, res) => {
  try {
    const folder = req.query.folder;
    let base = FOLDERS_BASE;
    let files;
    if (folder) {
      const resolved = path.resolve(folder);
      if (!resolved.startsWith(path.resolve(FOLDERS_BASE) + path.sep) && resolved !== path.resolve(FOLDERS_BASE)) {
        return res.status(400).json(fail(400, '非法目录路径'));
      }
      base = resolved;
      // Only scan direct children, not recursive
      files = [];
      let entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch { entries = []; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isFile() && isVideoExt(entry.name)) {
          files.push({ path: path.join(base, entry.name), name: entry.name });
        }
      }
    } else {
      files = scanVideoFiles(FOLDERS_BASE);
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    res.json(success(files));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, '读取文件列表失败'));
  }
});

app.get('/api/thumbnail', async (req, res) => {
  try {
    const fileName = req.query.name || req.query.file;
    if (!fileName) return res.status(400).send('缺少文件名');

    const safeName = decodeSafe(fileName);
    const videoPath = path.join(VIDEO_DIR, safeName);

    const thumbPath = getThumbPath(safeName, THUMB_DIR);

    if (fs.existsSync(thumbPath)) {
      return res.sendFile(thumbPath);
    }

    const videoId = detectVideoIdFromName(safeName);

    if (videoId) {
      try {
        const coverUrl = await fetchBiliCover(videoId);
        console.log('尝试获取B站封面，视频ID:', videoId, '封面URL:', coverUrl);
        if (coverUrl) {
          await downloadImage(coverUrl, thumbPath);
          if (fs.existsSync(thumbPath)) {
            return res.sendFile(thumbPath);
          }
        }
      } catch (e) {
        console.log('B站封面获取失败，回退本地截图');
      }
    }

    await generateLocalThumb(videoPath, thumbPath);

    if (!fs.existsSync(thumbPath)) {
      return res.status(500).send('缩略图生成失败');
    }

    res.sendFile(thumbPath);
  } catch (err) {
    console.error(err);
    res.status(500).send('缩略图失败');
  }
});

app.get('/video/:name', (req, res) => {
  try {
    const fileName = decodeSafe(req.params.name);
    const videoPath = resolveVideoPath(fileName, VIDEO_DIR);

    if (!fs.existsSync(videoPath)) {
      return res.status(404).send('视频文件不存在');
    }

    streamDirect(videoPath, req, res);
  } catch (err) {
    console.error(err);
    res.status(400).send('非法请求');
  }
});

// stream接口兼容之前的请求方式，支持查询参数name指定视频文件
app.get('/stream', (req, res) => {
  try {
    const fileName = decodeSafe(String(req.query.name || ''));
    if (!fileName) return res.status(400).send('缺少文件名');

    const videoPath = resolveVideoPath(fileName, VIDEO_DIR);
    console.log('Streaming video:', videoPath);

    if (!fs.existsSync(videoPath)) {
      return res.status(404).send('文件不存在');
    }

    const ext = path.extname(videoPath).toLowerCase();
    const directPlayable = new Set(['.mp4', '.mov', '.webm', '.m4v']);
    if (directPlayable.has(ext)) {
      return streamDirect(videoPath, req, res);
    }

    return transcodeStream(videoPath, req, res);
  } catch (err) {
    console.error(err);
    res.status(400).send('非法请求');
  }
});

app.post('/api/progress', (req, res) => {
  const { id, time } = req.body || {};
  if (!id) return res.status(400).json(fail(400, '缺少ID'));

  const safeId = String(id).replace(/\//g, '／');
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

  const saveTime = Number(time) || 0;
  fs.writeFileSync(file, JSON.stringify({
    id,
    time: saveTime,
    updatedAt: Date.now()
  }, null, 2));

  console.log(`💾 [progress] 保存: ${id} → ${saveTime}s`);
  res.json(success(null));
});

app.get('/api/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少ID'));

  const safeId = String(id).replace(/\//g, '／');
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

  // 兼容旧的 URL 编码文件名
  const legacyFile = path.join(PLAYBACK_DIR, `${encodeURIComponent(String(id))}.json`);
  const actualFile = fs.existsSync(file) ? file : (fs.existsSync(legacyFile) ? legacyFile : null);

  if (!actualFile) {
    return res.json(success({ time: 0 }));
  }

  try {
    res.json(success(JSON.parse(fs.readFileSync(actualFile, 'utf-8'))));
  } catch {
    res.json(success({ time: 0 }));
  }
});

// IINA 播放状态同步（供 overlay 轮询）
let iinaState = { paused: false, time: 0 };
app.post('/api/iina-state', (req, res) => {
  const { paused, time } = req.body || {};
  if (typeof paused === 'boolean') iinaState.paused = paused;
  if (typeof time === 'number') iinaState.time = time;
  res.json(success(iinaState));
});
app.get('/api/iina-state', (_req, res) => {
  res.json(success(iinaState));
});

app.post('/api/rename', async (req, res) => {
  try {
    const { folderPath, biliUrl } = req.body || {};

    if (!folderPath || !biliUrl) {
      return res.status(400).json(fail(400, '缺少文件夹路径或B站链接'));
    }

    if (!fs.existsSync(folderPath)) {
      return res.status(400).json(fail(400, '文件夹不存在'));
    }

    const epId = extractEpId(biliUrl);
    if (!epId) {
      return res.status(400).json(fail(400, '无法识别EP号'));
    }

    const season = await fetchSeasonInfo(epId);
    const seasonTitle = sanitizeFileName(season.title);
    const episodes = (season.episodes || []).slice().sort((a, b) => {
      return Number(a?.title || 0) - Number(b?.title || 0);
    });

    const videoFiles = fs.readdirSync(folderPath)
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

      if (!ep) {
        ep = episodes[index];
      }

      if (!ep || usedEpisodeIds.has(ep.id)) return;

      const ext = path.extname(file);
      const episodeNumber = String(
        detectedEpisodeNumber != null ? detectedEpisodeNumber : Number(ep.title || index + 1)
      ).padStart(2, '0');

      const newName = `EP${episodeNumber}_${seasonTitle}_ep${ep.id}${ext}`;

      const oldPath = path.join(folderPath, file);
      const newPath = path.join(folderPath, newName);

      fs.renameSync(oldPath, newPath);
      usedEpisodeIds.add(ep.id);

      renamedFiles.push({
        oldName: file,
        newName,
        matchedEpisode: Number(ep.title || episodeNumber),
        matchedEpId: ep.id
      });
    });

    const mappingPath = path.join(folderPath, 'mapping.json');
    fs.writeFileSync(mappingPath, JSON.stringify(renamedFiles, null, 2));

    res.json(success({
      seasonTitle,
      totalFiles: renamedFiles.length,
      renamedFiles
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, err.message || '重命名失败'));
  }
});

app.post('/api/convert', (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json(fail(400, '缺少 filePath 参数'));
    }
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json(fail(400, `文件不存在: ${resolvedPath}`));
    }

    const dir = path.dirname(resolvedPath);
    const ext = path.extname(resolvedPath);
    const base = path.basename(resolvedPath, ext);
    const outputPath = path.join(dir, `${base}_browser.mp4`);

    const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = { id: taskId, input: resolvedPath, output: outputPath, status: 'probing', progress: 0, duration: 0, startTime: Date.now() };
    convertTasks.set(taskId, task);
    saveConvertHistory(task);

    // 用 ffprobe 获取视频总时长
    const probe = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', resolvedPath
    ]);
    let probeOutput = '';
    probe.stdout.on('data', d => probeOutput += d.toString());
    probe.on('close', (code) => {
      if (code === 0) {
        task.duration = Math.round(parseFloat(probeOutput.trim()) || 0);
      }
      task.status = 'running';
      startFfmpeg(task);
    });
    probe.on('error', () => {
      task.status = 'running';
      startFfmpeg(task);
    });

    // 启动 ffmpeg 转码，通过 stdout 读取进度
    function startFfmpeg(task) {
      const args = [
        '-i', task.input,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'h264_videotoolbox',
        '-b:v', '5000k',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        '-y',
        task.output
      ];

      console.log(`[convert] 开始转换: ${task.input} -> ${task.output}`);

      const ffmpeg = spawn('ffmpeg', args);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      let lastProgress = '';
      ffmpeg.stdout.on('data', (data) => {
        lastProgress += data.toString();
        const timeMatch = lastProgress.match(/out_time_us=(\d+)/);
        if (timeMatch) {
          lastProgress = '';
          task.progress = Math.floor(Number(timeMatch[1]) / 1000000);
        }
      });

      ffmpeg.on('close', (code) => {
        task.endTime = Date.now();
        if (code === 0) {
          task.status = 'done';
          console.log(`[convert] 完成: ${task.output}`);
        } else {
          task.status = 'error';
          task.error = stderr.slice(-500);
          console.error(`[convert] 失败: ${stderr.slice(-300)}`);
        }
        saveConvertHistory(task);
      });

      ffmpeg.on('error', (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = Date.now();
        saveConvertHistory(task);
        console.error(`[convert] ffmpeg 启动失败:`, err.message);
      });
    }

    res.json(success({ taskId, output: outputPath, duration: task.duration }));
  } catch (err) {
    console.error(err);
    res.status(500).json(fail(500, err.message || '转换失败'));
  }
});

app.get('/api/convert/status', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少任务ID'));
  const task = convertTasks.get(id);
  if (!task) {
    // 任务不在内存中，尝试从历史文件查找
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
      const found = history.find(t => t.id === id);
      if (found) return res.json(success(found));
    }
    return res.status(404).json(fail(404, '任务不存在'));
  }
  res.json(success(task));
});

app.get('/api/convert/history', (req, res) => {
  try {
    const running = [];
    for (const t of convertTasks.values()) {
      if (t.status === 'running' || t.status === 'probing') {
        running.push(t);
      }
    }
    let history = [];
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
    }
    res.json(success([...running, ...history].slice(0, 20)));
  } catch (err) {
    res.json(success([]));
  }
});

const localIP = getLocalIP();
app.listen(PORT, '0.0.0.0', () => {
  console.log('服务器已在局域网启动！');
  console.log(`本机请访问: http://localhost:${PORT}/video.html`);
  console.log(`iPad访问: http://${localIP}:${PORT}/video.html`);
});
