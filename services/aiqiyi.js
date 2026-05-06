const axios = require('axios');
const zlib = require('zlib');
const logger = require('../utils/logger');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

/** 下载一页弹幕（旧版 XML + zlib） */
async function fetchPage(tvid, page) {
  const a = tvid.slice(-4, -2);
  const b = tvid.slice(-2);
  const url = `https://cmts.iqiyi.com/bullet/${a}/${b}/${tvid}_300_${page}.z`;
  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000, responseType: 'arraybuffer', validateStatus: () => true });
  if (resp.status !== 200) { logger.debug(`[aiqiyi] 第 ${page} 页 HTTP ${resp.status}`); return null; }
  try {
    const buf = Buffer.from(resp.data);
    return zlib.inflateSync(buf).toString('utf-8');
  } catch {
    return null;
  }
}

/** 解析一页 XML，返回标准化弹幕数组 */
function parseXml(xml) {
  const results = [];
  // 匹配 <bulletInfo> ... </bulletInfo>
  const entries = xml.match(/<bulletInfo>[\s\S]*?<\/bulletInfo>/g) || [];
  for (const entry of entries) {
    const content = (entry.match(/<content>(.*?)<\/content>/) || [])[1];
    if (!content) continue;
    const showTime = parseInt(((entry.match(/<showTime>(\d+)<\/showTime>/) || [])[1] || '0'), 10);
    const color = ((entry.match(/<color>(.*?)<\/color>/) || [])[1] || 'ffffff');
    const likes = parseInt(((entry.match(/<likeCount>(.*?)<\/likeCount>/) || [])[1] || '0'), 10);

    results.push({
      text: content,
      time: showTime, // showTime 单位是秒
      color: '#' + color,
      mode: 'scroll',
      ctime: 0,
    });
  }
  return results;
}

/** 拉取 tvid 的全部弹幕 */
async function fetchAiQiYiDanmaku(tvid) {
  const all = [];
  let page = 1;
  while (true) {
    logger.debug(`[aiqiyi] 请求第 ${page} 页`);
    const xml = await fetchPage(tvid, page);
    if (!xml) break;
    const danmakus = parseXml(xml);
    all.push(...danmakus);
    logger.debug(`[aiqiyi] 第 ${page} 页: ${danmakus.length} 条 (累计 ${all.length})`);
    if (danmakus.length === 0) break;
    page++;
  }
  logger.info(`[aiqiyi] 完成: ${all.length} 条弹幕, ${page - 1} 页`);
  return all;
}

module.exports = { fetchAiQiYiDanmaku };
