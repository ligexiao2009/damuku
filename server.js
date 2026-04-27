const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require("os");
const { XMLParser } = require('fast-xml-parser');
const protobuf = require('protobufjs');
require('dotenv').config();

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// 确保 public 文件夹存在，存放 video.html
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

const PLAYBACK_DIR = path.join(__dirname, 'playback');
if (!fs.existsSync(PLAYBACK_DIR)) fs.mkdirSync(PLAYBACK_DIR);

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

async function fetchVideoMetaByBvid(bvid) {
    const url = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;
    const res = await axios.get(url, { headers: getRequestHeaders() });
    if (!res.data.data || !res.data.data[0]) throw new Error('无效BV号');
    const page = res.data.data[0];
    return { aid: page.aid, cid: page.cid, duration: page.duration };
}

async function fetchVideoMetaByEpid(epid) {
    const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`;
    const epRes = await axios.get(url, { headers: getRequestHeaders() });
    const episodes = epRes.data?.result?.episodes || [];
    const current = episodes.find(ep => String(ep.id) === String(epid));
    if (!current) throw new Error('无效EP号');
    return { aid: current.aid, cid: current.cid, duration: current.duration };
}

async function fetchDanmuXml(cid) {
    const url = `https://comment.bilibili.com/${cid}.xml`;
    const res = await axios.get(url, { headers: getRequestHeaders() });
    return res.data;
}

async function fetchDanmuSeg({ cid, aid, segmentIndex }) {
    const url = 'https://api.bilibili.com/x/v2/dm/web/seg.so';
    const res = await axios.get(url, {
        params: { type: 1, pid: aid, oid: cid, segment_index: segmentIndex },
        responseType: 'arraybuffer',
        headers: getRequestHeaders()
    });
    return Buffer.from(res.data);
}

function parseDanmu(xml) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    let items = parsed?.i?.d || [];
    if (!Array.isArray(items)) items = [items];
    return items.map(item => {
        const p = item['@_p'].split(',');
        return {
            time: parseFloat(p[0]),
            mode: parseInt(p[1]),
            size: parseInt(p[2]),
            color: '#' + parseInt(p[3]).toString(16).padStart(6, '0'),
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

// 核心接口：获取弹幕
app.get('/api/danmu', async (req, res) => {
    try {
        const { id } = req.query;
        const strategy = req.query.strategy === 'seg.so' ? 'seg.so' : 'xml';
        const forceRefresh = req.query.refresh === '1';

        if (!id) return res.status(400).json({ error: '缺少视频ID' });

        let cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${id.replace(/^ep/i, '')}`;
        const [cacheFile] = getCacheFilePaths(cacheKey, strategy);

        if (!forceRefresh && fs.existsSync(cacheFile)) {
            return res.json({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true });
        }

        const videoMeta = id.toUpperCase().startsWith('BV')
            ? await fetchVideoMetaByBvid(id)
            : await fetchVideoMetaByEpid(id.replace(/^ep/i, ''));

        let danmus = [];
        if (strategy === 'seg.so') {
            const segmentCount = Math.max(1, Math.ceil((videoMeta.duration || 0) / 360));
            const segments = await Promise.all(Array.from({ length: segmentCount }, (_, i) =>
                fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: i + 1 })
            ));
            danmus = segments.flatMap(parseDanmuSeg);
        } else {
            const xml = await fetchDanmuXml(videoMeta.cid);
            danmus = parseDanmu(xml);
        }

        const result = { strategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
        fs.writeFileSync(cacheFile, JSON.stringify(result));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/videos', (req, res) => {
    try {
        console.log("__dirname:" + VIDEO_DIR)
        const files = fs.readdirSync(VIDEO_DIR);
        // 过滤出视频文件
        const videoFiles = files.filter(f => /\.(mp4|mkv|mov|webm|avi)$/i.test(f));
        res.json(videoFiles);
    } catch (err) {
        res.status(500).json({ error: '无法读取文件列表' });
    }
});

// 在 app.listen 之前添加这个接口
app.get('/video/:name', (req, res) => {
    const videoPath = path.join(VIDEO_DIR, req.params.name); // 确保视频在 server.js 同级
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('视频文件不存在');
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        // 为 Safari/iPad 提供分段读取支持
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
    }
});

// ============== 视频流媒体分段接口 ==============
const { spawn } = require('child_process');
const mime = require('mime-types');

app.get('/stream', (req, res) => {
    const fileName = req.query.name;
    if (!fileName) return res.status(400).send('缺少文件名');

    const videoPath = path.join(VIDEO_DIR, fileName);

    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('文件不存在');
    }

    const ext = path.extname(videoPath).toLowerCase();

    // 原生兼容格式直接播放
    if (ext === '.mp4') {
        return streamDirect(videoPath, req, res);
    }

    // 非兼容格式实时转码
    // res.writeHead(200, {
    //     'Content-Type': 'video/mp4',
    //     'Transfer-Encoding': 'chunked',
    //     'Accept-Ranges': 'none'
    // });

    // const ffmpeg = spawn('ffmpeg', [
    //     '-i', videoPath,
    //     '-c:v', 'libx264',
    //     '-preset', 'ultrafast',
    //     '-crf', '23',
    //     '-c:a', 'aac',
    //     '-b:a', '128k',
    //     '-movflags', 'frag_keyframe+empty_moov',
    //     '-f', 'mp4',
    //     'pipe:1'
    // ]);

    // ffmpeg.stdout.pipe(res);

    // ffmpeg.stderr.on('data', data => {
    //     console.log(data.toString());
    // });

    // ffmpeg.on('close', code => {
    //     res.end();
    // });

    // req.on('close', () => {
    //     ffmpeg.kill('SIGKILL');
    // });
});

function streamDirect(videoPath, req, res) {
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(videoPath).toLowerCase();

    let contentType = 'video/mp4';

    if (ext === '.webm') contentType = 'video/webm';
    else if (ext === '.mov') contentType = 'video/quicktime';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1]
            ? parseInt(parts[1], 10)
            : fileSize - 1;

        const chunkSize = (end - start) + 1;

        const fileStream = fs.createReadStream(videoPath, {
            start,
            end
        });

        const headers = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
        };

        res.writeHead(206, headers);
        fileStream.pipe(res);

    } else {
        const headers = {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        };

        res.writeHead(200, headers);
        fs.createReadStream(videoPath).pipe(res);
    }
}

// ============== 视频流媒体分段接口结束 ==============

// 保存播放进度接口
app.post('/api/progress', (req, res) => {
    const { id, time } = req.body;

    if (!id) return res.status(400).json({ error: '缺少ID' });

    const safeId = encodeURIComponent(id);
    const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

    fs.writeFileSync(file, JSON.stringify({
        id,
        time,
        updatedAt: Date.now()
    }));

    res.json({ success: true });
});
// 获取播放进度接口
app.get('/api/progress', (req, res) => {
    const { id } = req.query;

    if (!id) return res.status(400).json({ error: '缺少ID' });

    const safeId = encodeURIComponent(id);
    const file = path.join(PLAYBACK_DIR, `${safeId}.json`);

    if (!fs.existsSync(file)) {
        return res.json({ time: 0 });
    }

    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

app.post('/api/rename', async (req, res) => {
    try {
        const { folderPath, biliUrl } = req.body || {};

        if (!folderPath || !biliUrl) {
            return res.status(400).json({
                error: '缺少文件夹路径或B站链接'
            });
        }

        if (!fs.existsSync(folderPath)) {
            return res.status(400).json({
                error: '文件夹不存在'
            });
        }

        const epId = extractEpId(biliUrl);

        if (!epId) {
            return res.status(400).json({
                error: '无法识别EP号'
            });
        }

        const season = await fetchSeasonInfo(epId);
        const seasonTitle = sanitizeFileName(season.title);
        const episodes = (season.episodes || []).slice().sort((a, b) => {
            return Number(a?.title || 0) - Number(b?.title || 0);
        });

        const videoFiles = fs.readdirSync(folderPath)
            .filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file))
            .sort();

        if (videoFiles.length === 0) {
            return res.status(400).json({
                error: '文件夹内没有视频文件'
            });
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

        fs.writeFileSync(
            mappingPath,
            JSON.stringify(renamedFiles, null, 2)
        );

        res.json({
            success: true,
            seasonTitle,
            totalFiles: renamedFiles.length,
            renamedFiles
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: err.message || '重命名失败'
        });
    }
});

function extractEpId(input) {
    const match = input.match(/ep(\d+)/i);
    if (match) return match[1];

    if (/^\d+$/.test(input.trim())) {
        return input.trim();
    }

    return null;
}

function sanitizeFileName(name) {
    return name
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

async function fetchSeasonInfo(epId) {
    const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`;

    const res = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    if (!res.data.result) {
        throw new Error('无法获取B站剧集信息');
    }

    return res.data.result;
}




function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (
        net.family === "IPv4" &&
        !net.internal &&
        net.address.startsWith("192.168.")
      ) {
        return net.address;
      }
    }
  }

  return "localhost";
}

const localIP = getLocalIP();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器已在局域网启动！`);
    console.log(`本机请访问: http://localhost:${PORT}/video.html`);
    console.log(`iPad访问: http://${localIP}:${PORT}/video.html`);
});