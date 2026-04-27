
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
        'User-Agent': 'Mozilla/5.0'
    };

    if (process.env.BILI_SESSDATA) {
        headers.Cookie = `SESSDATA=${process.env.BILI_SESSDATA}`;
    }

    return headers;
}

function getStrategyCacheSuffix(strategy) {
    return strategy === 'seg.so' ? 'seg_so' : 'xml';
}

function getCacheFilePaths(cacheKey, strategy) {
    const suffix = getStrategyCacheSuffix(strategy);
    const primary = path.join(CACHE_DIR, `${cacheKey}.${suffix}.json`);
    const legacy = path.join(CACHE_DIR, `${cacheKey}.json`);

    if (strategy === 'xml') {
        return [primary, legacy];
    }

    return [primary];
}

async function fetchVideoMetaByBvid(bvid) {
    const url = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;

    const res = await axios.get(url, {
        headers: getRequestHeaders()
    });

    if (!res.data.data || !res.data.data[0]) {
        throw new Error('无效BV号');
    }

    const page = res.data.data[0];
    return {
        aid: Number(page.aid) || Number(res.data.data[0].aid) || 0,
        cid: page.cid,
        duration: Number(page.duration) || 0
    };
}

async function fetchVideoMetaByEpid(epid) {
    const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`;

    const epRes = await axios.get(url, {
        headers: getRequestHeaders()
    });

    const episodes = epRes.data?.result?.episodes || [];
    const current = episodes.find(
        ep => String(ep.id) === String(epid)
    );

    if (!current) {
        throw new Error('无效EP号');
    }

    const rawDuration = Number(current.duration) || 0;
    return {
        aid: Number(current.aid) || 0,
        cid: current.cid,
        duration: rawDuration > 10000 ? rawDuration / 1000 : rawDuration
    };
}

async function fetchDanmuXml(cid) {
    const url = `https://comment.bilibili.com/${cid}.xml`;
    const res = await axios.get(url, {
        headers: getRequestHeaders()
    });

    return res.data;
}

async function fetchDanmuSeg({ cid, aid, segmentIndex }) {
    const url = 'https://api.bilibili.com/x/v2/dm/web/seg.so';
    const res = await axios.get(url, {
        params: {
            type: 1,
            pid: aid,
            oid: cid,
            segment_index: segmentIndex
        },
        responseType: 'arraybuffer',
        headers: getRequestHeaders()
    });

    return Buffer.from(res.data);
}

function parseDanmu(xml) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_'
    });

    const parsed = parser.parse(xml);
    let items = parsed?.i?.d || [];

    if (!Array.isArray(items)) {
        items = [items];
    }

    return items.map(item => {
        const p = item['@_p'].split(',');

        return {
            time: parseFloat(p[0]),
            mode: parseInt(p[1]),
            size: parseInt(p[2]),
            color: '#' + parseInt(p[3]).toString(16).padStart(6, '0'),
            text: item['#text'] || item['__text'] || ''
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

async function loadDanmuByStrategy({ cid, aid, duration, strategy }) {
    if (strategy === 'seg.so') {
        const segmentCount = Math.max(1, Math.ceil((Number(duration) || 0) / 360));
        const segmentRequests = Array.from({ length: segmentCount }, (_, index) =>
            fetchDanmuSeg({
                cid,
                aid,
                segmentIndex: index + 1
            })
        );
        const segments = await Promise.all(segmentRequests);
        return segments.flatMap(parseDanmuSeg);
    }

    const xml = await fetchDanmuXml(cid);
    return parseDanmu(xml);
}

app.get('/api/danmu', async (req, res) => {
    try {
        const { id } = req.query;
        const strategy = req.query.strategy === 'seg.so' ? 'seg.so' : 'xml';
        const forceRefresh = req.query.refresh === '1';

        if (!id) {
            return res.status(400).json({
                error: '缺少视频ID'
            });
        }

        let bvid = null;
        let epid = null;
        let cacheKey = '';
        let videoMeta = null;

        // 自动判断类型
        if (id.toUpperCase().startsWith('BV')) {
            bvid = id.trim();
            cacheKey = bvid;
        } else {
            // 支持 ep1718519 或 1718519
            epid = id.replace(/^ep/i, '').trim();
            cacheKey = `ep${epid}`;
        }

        const [cacheFile, ...fallbackCacheFiles] = getCacheFilePaths(cacheKey, strategy);

        // 缓存命中
        if (!forceRefresh) {
            for (const filePath of [cacheFile, ...fallbackCacheFiles]) {
                if (fs.existsSync(filePath)) {
                    const cached = JSON.parse(
                        fs.readFileSync(filePath, 'utf-8')
                    );

                    return res.json({
                        ...cached,
                        fromCache: true,
                        forceRefresh: false
                    });
                }
            }
        }

        if (bvid) {
            videoMeta = await fetchVideoMetaByBvid(bvid);
        }

        if (epid) {
            videoMeta = await fetchVideoMetaByEpid(epid);
        }

        const cid = videoMeta?.cid;
        if (!cid) {
            throw new Error('CID获取失败');
        }

        const danmus = await loadDanmuByStrategy({
            cid,
            aid: videoMeta?.aid,
            duration: videoMeta?.duration,
            strategy
        });

        const result = {
            strategy,
            source: bvid ? 'bvid' : 'epid',
            id,
            cid,
            count: danmus.length,
            fromCache: false,
            forceRefresh,
            danmus
        };

        // 写缓存
        fs.writeFileSync(
            cacheFile,
            JSON.stringify(result)
        );

        res.json(result);

    } catch (err) {
        console.error('弹幕接口错误:', err);

        res.status(500).json({
            error: err.message || '服务器错误'
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
        const episodes = season.episodes;

        const videoFiles = fs.readdirSync(folderPath)
            .filter(file => /\.(mp4|mkv|avi|mov)$/i.test(file))
            .sort();

        if (videoFiles.length === 0) {
            return res.status(400).json({
                error: '文件夹内没有视频文件'
            });
        }

        const renamedFiles = [];

        videoFiles.forEach((file, index) => {
            if (!episodes[index]) return;

            const ep = episodes[index];
            const ext = path.extname(file);
            const episodeNumber = String(index + 1).padStart(2, '0');

            const newName = `EP${episodeNumber}_${seasonTitle}_ep${ep.id}${ext}`;

            const oldPath = path.join(folderPath, file);
            const newPath = path.join(folderPath, newName);

            fs.renameSync(oldPath, newPath);

            renamedFiles.push({
                oldName: file,
                newName
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


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
