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
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_DIR = path.join(CACHE_DIR, 'meta');
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');

for (const dir of [CACHE_DIR, PLAYBACK_DIR, THUMB_DIR, META_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (process.env.BILI_SESSDATA) {
    headers.Cookie = `SESSDATA=${process.env.BILI_SESSDATA}`;
  }
  return headers;
}

function getCacheFilePaths(cacheKey, strategy) {
  const suffix = strategy === 'seg.so' ? 'seg_so' : 'xml';
  return [path.join(CACHE_DIR, `${cacheKey}.${suffix}.json`)];
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
    duration: current.duration || 0,
    title: epRes.data?.result?.title || current.share_copy || '',
    cover: epRes.data?.result?.cover || '',
    owner: '',
    desc: epRes.data?.result?.evaluate || ''
  };
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
  const res = await axios.get(url, {
    params: { type: 1, pid: aid, oid: cid, segment_index: segmentIndex },
    responseType: 'arraybuffer',
    headers: getRequestHeaders(),
    timeout: 10000
  });
  return Buffer.from(res.data);
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
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
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
    const videoMeta = id.toUpperCase().startsWith('BV')
      ? await fetchVideoMetaByBvid(id)
      : await fetchVideoMetaByEpid(String(id).replace(/^ep/i, ''));

    let danmus = [];
    let strategy = requestedStrategy;

    if (requestedStrategy === 'seg.so') {
      try {
        const segmentCount = Math.max(1, Math.ceil((videoMeta.duration || 0) / 360));
        console.log(`[seg.so] 开始加载弹幕，共 ${segmentCount} 个分段...`);
        console.time('[seg.so] 耗时');
        const segments = await Promise.all(
          Array.from({ length: segmentCount }, (_, i) =>
            fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: i + 1 })
          )
        );
        danmus = segments.flatMap(parseDanmuSeg);
        console.timeEnd('[seg.so] 耗时');
        console.log(`[seg.so] 加载完成，共 ${danmus.length} 条弹幕`);
      } catch (err) {
        console.timeEnd('[seg.so] 耗时');
        console.log('[seg.so] 获取失败，降级到 XML:', err.message);
        strategy = 'xml';
        console.time('[xml] 耗时');
        const xml = await fetchDanmuXml(videoMeta.cid);
        danmus = parseDanmu(xml);
        console.timeEnd('[xml] 耗时');
        console.log(`[xml] 加载完成，共 ${danmus.length} 条弹幕`);
      }
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

app.get('/stream', (req, res) => {
  try {
    const fileName = decodeSafe(String(req.query.name || ''));
    if (!fileName) return res.status(400).send('缺少文件名');

    const videoPath = resolveVideoPath(fileName);

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
