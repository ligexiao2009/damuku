const axios = require('axios');
const fs = require('fs');
const path = require('path');

/** 构造请求 B站 API 的通用请求头，包含 Cookie 认证。 */
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

/** 根据 BV 号请求视频元信息（cid、时长、标题等）。 */
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

/** 根据 EP 号请求番剧视频元信息。 */
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

/**
 * 获取视频元信息（先查缓存，未命中则请求 B站 API）。
 * @param {string} id - BV 号或 EP 号
 * @param {string} metaDir - 元信息缓存目录
 */
async function fetchVideoMeta(id, metaDir) {
  const cacheKey = id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
  const metaFile = path.join(metaDir, `${cacheKey}.json`);

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

/** 获取 B站番剧季度信息（包含所有分集列表）。 */
async function fetchSeasonInfo(epId) {
  const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`;
  const res = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });
  if (!res.data.result) {
    throw new Error('无法获取B站剧集信息');
  }
  return res.data.result;
}

/** 请求 B站 XML 格式弹幕（旧接口）。 */
async function fetchDanmuXml(cid) {
  const url = `https://comment.bilibili.com/${cid}.xml`;
  const res = await axios.get(url, { headers: getRequestHeaders(), timeout: 30000 });
  return res.data;
}

/** 请求 B站 protobuf 格式弹幕分段（新接口，每段 6 分钟）。 */
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

/** 通过 EP 号获取 B站番剧封面图 URL。 */
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

/** 通过 BV 号获取 B站视频封面图 URL。 */
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

/** 根据视频 ID 类型自动获取 B站封面图 URL。 */
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

/** 下载图片到本地指定路径。 */
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

module.exports = {
  getRequestHeaders,
  fetchVideoMeta,
  fetchSeasonInfo,
  fetchDanmuXml,
  fetchDanmuSeg,
  fetchBiliCover,
  downloadImage
};
