const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const protobuf = require('protobufjs');
require('dotenv').config();

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'cache');

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
        console.log("__dirname" + __dirname)
        const files = fs.readdirSync(__dirname);
        // 过滤出视频文件
        const videoFiles = files.filter(f => /\.(mp4|mkv|mov|webm|avi)$/i.test(f));
        res.json(videoFiles);
    } catch (err) {
        res.status(500).json({ error: '无法读取文件列表' });
    }
});

// 在 app.listen 之前添加这个接口
app.get('/video/:name', (req, res) => {
    const videoPath = path.join(__dirname, req.params.name); // 确保视频在 server.js 同级
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
app.get('/stream', (req, res) => {
    const fileName = req.query.name; // 获取参数中的文件名
    if (!fileName) return res.status(400).send("缺少文件名参数");

    // 拼装文件绝对路径，假设视频就在 server.js 同级目录
    const videoPath = path.join(__dirname, fileName);

    if (!fs.existsSync(videoPath)) {
        console.error(`文件未找到: ${videoPath}`);
        return res.status(404).send("视频文件不存在");
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // 特别针对 iPad/Safari 的 Range 请求处理
    if (range) {
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器已在局域网启动！`);
    console.log(`本机请访问: http://localhost:${PORT}/video.html`);
    console.log(`iPad 请访问: http://192.168.0.120:${PORT}/video.html`);
});