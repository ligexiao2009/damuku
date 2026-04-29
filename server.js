const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const protobuf = require('protobufjs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const CACHE_DIR = path.join(__dirname, 'cache');
const PLAYBACK_DIR = path.join(__dirname, 'playback');
const DANMU_DIR = path.join(CACHE_DIR, 'danmu');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_DIR = path.join(CACHE_DIR, 'meta');
const CONVERT_HISTORY_FILE = path.join(CACHE_DIR, 'convert_history.json');
const FOLDER_HISTORY_FILE = path.join(CACHE_DIR, 'folder_history.json');
const OVERLAY_CONFIG_FILE = path.join(CACHE_DIR, 'overlay_config.json');
let VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
const danmuProgressMap = new Map();
const convertTasks = new Map();


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
app.use(express.static('public'));

const DM_PROTO = `
syntax = "proto3";

message DanmakuElem {
  int64 id = 1;
  int32 progress = 2;
  int32 mode = 3;
  int32 fontsize = 4;
  uint32 color = 5;
  string midHash = 6;
  string content = 7;
  int64 ctime = 8;
  int32 weight = 9;
  string action = 10;
  int32 pool = 11;
  string idStr = 12;
  int32 attr = 13;
}

message DmSegMobileReply {
  repeated DanmakuElem elems = 1;
}
`;

const dmRoot = protobuf.parse(DM_PROTO).root;
const DmSegMobileReply = dmRoot.lookupType('DmSegMobileReply');

function getRequestHeaders() {
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://www.bilibili.com'
  };
  if (process.env.BILI_SESSDATA) {
    headers.Cookie = `SESSDATA=${process.env.BILI_SESSDATA}`;
  }
  return headers;
}

function getCacheFilePaths(cacheKey, strategy) {
  const suffix = strategy === 'seg.so' ? 'seg_so' : 'xml';
  return [path.join(DANMU_DIR, `${cacheKey}.${suffix}.json`)];
}

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

function normalizeRelativePath(relativePath) {
  const decoded = decodeSafe(relativePath);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized;
}

function resolveVideoPath(relativeName) {
  const normalized = normalizeRelativePath(relativeName);
  const fullPath = path.resolve(VIDEO_DIR, normalized);
  const basePath = path.resolve(VIDEO_DIR);

  if (fullPath !== basePath && !fullPath.startsWith(basePath + path.sep)) {
    throw new Error('非法路径');
  }
  return fullPath;
}

function getVideoMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    default: return 'application/octet-stream';
  }
}

function isVideoExt(fileName) {
  return /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(fileName);
}

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

function detectVideoIdFromName(name) {
  if (!name) return '';
  const baseName = path.basename(name).replace(/\.[^.]+$/, '');
  const bvidMatch = baseName.match(/BV[0-9A-Za-z]+/i);
  if (bvidMatch) return bvidMatch[0];
  const explicitEpMatch = baseName.match(/(?:^|[_\s-])(ep\d{4,})(?=$|[_\s-])/i);
  if (explicitEpMatch) return explicitEpMatch[1];
  return '';
}

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

async function fetchVideoMetaByBvid(bvid) {
  console.log('Fetching video metadata for BV ID:', bvid);
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const res = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });

  const data = res.data?.data;
  if (!data) throw new Error('无效BV号');

  const page0 = data.pages?.[0] || {};
  return {
    aid: data.aid,
    cid: page0.cid || data.cid,
    duration: page0.duration || data.duration || 0,
    title: data.title || '',
    cover: data.pic || '',
    owner: data.owner?.name || '',
    desc: data.desc || ''
  };
}

async function fetchVideoMetaByEpid(epid) {
  const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(epid)}`;
  const epRes = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });

  const episodes = epRes.data?.result?.episodes || [];
  const current = episodes.find(ep => String(ep.id) === String(epid));
  if (!current) throw new Error('无效EP号');

  return {
    aid: current.aid,
    cid: current.cid,
    duration: Math.round((current.duration || 0) / 1000),
    title: epRes.data?.result?.title || current.share_copy || '',
    cover: epRes.data?.result?.cover || '',
    owner: '',
    desc: epRes.data?.result?.evaluate || ''
  };
}

async function fetchVideoMeta(id) {
  const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
  const metaFile = path.join(META_DIR, `${cacheKey}.json`);

  if (fs.existsSync(metaFile)) {
    console.log('Using cached video meta for:', id);
    return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  }

  console.log('Fetching video meta for:', id);
  const meta = id.toUpperCase().startsWith('BV')
    ? await fetchVideoMetaByBvid(id)
    : await fetchVideoMetaByEpid(String(id).replace(/^ep/i, ''));

  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

async function fetchSeasonInfo(epId) {
  const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`;
  const res = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });
  if (!res.data.result) {
    throw new Error('无法获取B站剧集信息');
  }
  return res.data.result;
}

async function fetchDanmuXml(cid) {
  const url = `https://comment.bilibili.com/${cid}.xml`;
  const res = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });
  return res.data;
}

async function fetchDanmuSeg({ cid, aid, segmentIndex }) {
  const url = 'https://api.bilibili.com/x/v2/dm/web/seg.so';
  const params = { type: 1, pid: aid, oid: cid, segment_index: segmentIndex };
  console.log(`[seg.so] 请求分段 ${segmentIndex}: cid=${cid} aid=${aid}`);
  try {
    const res = await axios.get(url, {
      params,
      responseType: 'arraybuffer',
      headers: getRequestHeaders(),
      timeout: 10000
    });
    console.log(`[seg.so] 分段 ${segmentIndex} 响应: status=${res.status} size=${res.data.length}`);
    return Buffer.from(res.data);
  } catch (err) {
    const detail = err.response
      ? `status=${err.response.status} body=${Buffer.from(err.response.data || '').toString('utf-8').slice(0, 200)}`
      : err.message;
    console.log(`[seg.so] 分段 ${segmentIndex} 请求失败: ${detail}`);
    throw err;
  }
}

function tryParseDanmuSeg(buffer, segmentIndex) {
  const str = Buffer.from(buffer).toString('utf-8', 0, Math.min(buffer.length, 200));
  if (str.startsWith('{')) {
    console.log(`[seg.so] 分段 ${segmentIndex} B站返回了JSON错误:`, str);
    return [];
  }
  try {
    return parseDanmuSeg(buffer);
  } catch (err) {
    console.log(`[seg.so] 分段 ${segmentIndex} protobuf 解析失败:`, err.message, `| 前200字节:`, str);
    return [];
  }
}

function parseDanmu(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  let items = parsed?.i?.d || [];
  if (!Array.isArray(items)) items = [items];

  return items.map(item => {
    const p = String(item['@_p'] || '').split(',');
    return {
      time: parseFloat(p[0] || '0'),
      mode: parseInt(p[1] || '1', 10),
      size: parseInt(p[2] || '25', 10),
      color: '#' + parseInt(p[3] || '16777215', 10).toString(16).padStart(6, '0'),
      text: item['#text'] || ''
    };
  }).filter(d => d.text);
}

function parseDanmuSeg(buffer) {
  const decoded = DmSegMobileReply.decode(buffer);
  return (decoded.elems || []).map(item => ({
    time: Number(item.progress || 0) / 1000,
    mode: Number(item.mode || 1),
    size: Number(item.fontsize || 25),
    color: '#' + Number(item.color || 16777215).toString(16).padStart(6, '0'),
    text: item.content || ''
  })).filter(d => d.text);
}

function streamDirect(videoPath, req, res) {
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let contentType = getVideoMimeType(videoPath);
  if (!contentType || contentType === 'application/octet-stream') {
    contentType = 'video/mp4';
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    const fileStream = fs.createReadStream(videoPath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(videoPath).pipe(res);
  }
}

function transcodeStream(videoPath, req, res) {
  if (req.headers.range) {
    res.setHeader('Accept-Ranges', 'none');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache'
  });

  const ffmpegArgs = [
    '-hwaccel', 'videotoolbox',
    '-i', videoPath,
    '-c:v', 'h264_videotoolbox',
    '-b:v', '6000k',
    // 尝试在硬件层强制指定输出色彩空间
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-pix_fmt', 'yuv420p', 
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', data => {
    const msg = data.toString();
    if (msg) console.log('[ffmpeg]', msg.trim());
  });

  ffmpeg.on('error', err => {
    console.error('FFmpeg 启动失败:', err);
    if (!res.headersSent) {
      res.status(500).send('FFmpeg 启动失败');
    } else {
      res.end();
    }
  });

  ffmpeg.on('close', () => {
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    try { ffmpeg.kill('SIGKILL'); } catch { }
  });
}

async function generateLocalThumb(videoPath, thumbPath) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-ss', '00:00:05',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      thumbPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    ffmpeg.stderr.on('data', data => {
      const msg = data.toString();
      if (msg) console.log('[ffmpeg-thumb]', msg.trim());
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(thumbPath)) resolve();
      else reject(new Error(`缩略图生成失败，ffmpeg退出码 ${code}`));
    });
  });
}

function getThumbPath(fileName) {
  if (!fileName) return null;
  const safeBaseName = path.basename(fileName);
  const encodedName = encodeURIComponent(safeBaseName).replace(/%/g, '_');
  return path.join(THUMB_DIR, `${encodedName}.jpg`);
}

async function downloadImage(url, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.bilibili.com/'
        },
        timeout: 15000
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      writer.on('finish', () => resolve(outputPath));
      writer.on('error', (err) => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        reject(err);
      });
    } catch (err) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      reject(err);
    }
  });
}

// ==================== API routes ====================

app.get('/api/danmu/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少视频ID' });
  const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
  const progress = danmuProgressMap.get(cacheKey);
  res.json(progress || null);
});

app.get('/api/danmu', async (req, res) => {
  try {
    const { id } = req.query;
    const requestedStrategy = req.query.strategy === 'seg.so' ? 'seg.so' : 'xml';
    const forceRefresh = req.query.refresh === '1';

    if (!id) return res.status(400).json({ error: '缺少视频ID' });

    const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
    const [cacheFile] = getCacheFilePaths(cacheKey, requestedStrategy);

    if (!forceRefresh && fs.existsSync(cacheFile)) {
      return res.json({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true });
    }
    console.log('Fetching danmu for ID:', id, 'Strategy:', requestedStrategy, 'Force Refresh:', forceRefresh);
    const videoMeta = await fetchVideoMeta(id);

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

    const cacheFileFinal = getCacheFilePaths(cacheKey, strategy)[0];
    const result = { strategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
    fs.writeFileSync(cacheFileFinal, JSON.stringify(result, null, 2));
    res.json(result);
  } catch (err) {
    danmuProgressMap.delete(cacheKey);
    res.status(500).json({ error: err.message });
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
    res.json({ ...config, maxDuration });
  } catch {
    res.json({ offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25, maxDuration: 10800 });
  }
});

app.put('/api/overlay-config', (req, res) => {
  try {
    const defaults = { offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 };
    const config = { ...defaults, ...req.body };
    fs.writeFileSync(OVERLAY_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/folder-history', (req, res) => {
  try {
    if (!fs.existsSync(FOLDER_HISTORY_FILE)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8')));
  } catch (err) {
    res.json({});
  }
});

app.put('/api/folder-history', (req, res) => {
  try {
    const { dir, name } = req.body;
    if (!dir || name == null) return res.status(400).json({ error: '缺少参数' });
    let history = {};
    if (fs.existsSync(FOLDER_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8'));
    }
    history[dir] = name;
    fs.writeFileSync(FOLDER_HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/videos', (req, res) => {
  try {
    console.log('VIDEO_DIR:', VIDEO_DIR);
    const files = scanVideos(VIDEO_DIR);
    files.sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    );
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '无法读取文件列表' });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const { videoDir } = req.body;
    if (!videoDir || typeof videoDir !== 'string') {
      return res.status(400).json({ error: '缺少 videoDir 参数' });
    }
    const resolved = path.resolve(videoDir);
    if (!fs.existsSync(resolved)) {
      return res.status(400).json({ error: `目录不存在: ${resolved}` });
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: `路径不是目录: ${resolved}` });
    }
    VIDEO_DIR = resolved;
    console.log('VIDEO_DIR updated to:', VIDEO_DIR);
    res.json({ videoDir: VIDEO_DIR });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新配置失败' });
  }
});

const FOLDERS_BASE = process.env.FOLDERS_BASE || path.join(os.homedir(), 'video');

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

function hasDirectVideoFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).some(e => e.isFile() && isVideoExt(e.name));
  } catch {
    return false;
  }
}

app.get('/api/folders', (req, res) => {
  try {
    const allFolders = scanFolders(FOLDERS_BASE);
    // 只保留直接包含视频文件的目录（不递归子目录）
    const folders = [{ path: FOLDERS_BASE, name: '(根目录)' }]
      .concat(allFolders.filter(f => hasDirectVideoFiles(f.path)));
    res.json(folders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '读取文件夹列表失败' });
  }
});

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

app.get('/api/video-files', (req, res) => {
  try {
    const files = scanVideoFiles(FOLDERS_BASE);
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '读取文件列表失败' });
  }
});

async function fetchBiliCoverByEpid(epid) {
  try {
    const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`;
    const res = await axios.get(url, {
      headers: getRequestHeaders(),
      timeout: 30000
    });
    const episodes = res.data?.result?.episodes || [];
    const current = episodes.find(ep => String(ep.id) === String(epid));
    return current?.cover || null;
  } catch (err) {
    console.error('EP封面获取失败:', epid, err.message);
    return null;
  }
}

async function fetchBiliCoverByBvid(bvid) {
  try {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const res = await axios.get(url, {
      headers: getRequestHeaders(),
      timeout: 30000
    });
    const pic = res.data?.data?.pic;
    if (!pic) return null;
    return pic.replace('http://', 'https://') + '@672w_378h_1c.jpg';
  } catch (err) {
    console.error('BV封面获取失败:', bvid, err.message);
    return null;
  }
}

async function fetchBiliCover(videoId) {
  if (!videoId) return null;

  if (videoId.toUpperCase().startsWith('BV')) {
    return await fetchBiliCoverByBvid(videoId);
  }

  if (videoId.toLowerCase().startsWith('ep')) {
    return await fetchBiliCoverByEpid(videoId.replace(/^ep/i, ''));
  }

  return null;
}

app.get('/api/thumbnail', async (req, res) => {
  try {
    const fileName = req.query.name || req.query.file;
    if (!fileName) return res.status(400).send('缺少文件名');

    const safeName = decodeSafe(fileName);
    const videoPath = path.join(VIDEO_DIR, safeName);

    const thumbPath = getThumbPath(safeName);

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
    const videoPath = resolveVideoPath(fileName);

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

    const videoPath = resolveVideoPath(fileName);
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
  if (!id) return res.status(400).json({ error: '缺少ID' });

  const safeId = encodeURIComponent(String(id));
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

  fs.writeFileSync(file, JSON.stringify({
    id,
    time: Number(time) || 0,
    updatedAt: Date.now()
  }, null, 2));

  res.json({ success: true });
});

app.get('/api/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少ID' });

  const safeId = encodeURIComponent(String(id));
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

  if (!fs.existsSync(file)) {
    return res.json({ time: 0 });
  }

  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    res.json({ time: 0 });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    const { folderPath, biliUrl } = req.body || {};

    if (!folderPath || !biliUrl) {
      return res.status(400).json({ error: '缺少文件夹路径或B站链接' });
    }

    if (!fs.existsSync(folderPath)) {
      return res.status(400).json({ error: '文件夹不存在' });
    }

    const epId = extractEpId(biliUrl);
    if (!epId) {
      return res.status(400).json({ error: '无法识别EP号' });
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
      return res.status(400).json({ error: '文件夹内没有视频文件' });
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

    res.json({
      success: true,
      seasonTitle,
      totalFiles: renamedFiles.length,
      renamedFiles
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '重命名失败' });
  }
});

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

app.post('/api/convert', (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: '缺少 filePath 参数' });
    }
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: `文件不存在: ${resolvedPath}` });
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

    res.json({ taskId, output: outputPath, duration: task.duration });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '转换失败' });
  }
});

app.get('/api/convert/status', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少任务ID' });
  const task = convertTasks.get(id);
  if (!task) {
    // 任务不在内存中，尝试从历史文件查找
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
      const found = history.find(t => t.id === id);
      if (found) return res.json(found);
    }
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(task);
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
    res.json([...running, ...history].slice(0, 20));
  } catch (err) {
    res.json([]);
  }
});

function extractEpId(input) {
  const str = String(input || '');
  const match = str.match(/ep(\d+)/i);
  if (match) return match[1];

  if (/^\d+$/.test(str.trim())) {
    return str.trim();
  }

  return null;
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

function extractEpisodeNumberFromFileName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const patterns = [
    /S\d+E(\d{1,3})/i,
    /(?:^|[\s._-])EP?(\d{1,3})(?=$|[\s._-])/i,
    /第\s*(\d{1,3})\s*[集话]/i
  ];

  for (const pattern of patterns) {
    const match = baseName.match(pattern);
    if (match) {
      const episodeNumber = Number.parseInt(match[1], 10);
      if (Number.isInteger(episodeNumber) && episodeNumber > 0) {
        return episodeNumber;
      }
    }
  }

  return null;
}

const localIP = getLocalIP();
app.listen(PORT, '0.0.0.0', () => {
  console.log('服务器已在局域网启动！');
  console.log(`本机请访问: http://localhost:${PORT}/video.html`);
  console.log(`iPad访问: http://${localIP}:${PORT}/video.html`);
});
