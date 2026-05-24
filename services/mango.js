const axios = require('axios');
const logger = require('../utils/logger');

/**
 * 抓取芒果TV弹幕（按60秒分片，顺序探测，连续2次NoSuchKey停止）
 * @param {string} videoId - 视频ID
 * @param {string} dateStr - 日期路径，格式 YYYY/MM/DD，默认今天
 * @param {string} timeStr - 时间标识，格式 HHMMSS，默认 000000
 * @returns {Array<{text, time, color, mode}>}
 */
async function fetchMangoDanmaku(videoId, dateStr, timeStr) {
  const now = new Date();
  const date = dateStr || `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getDate()}`;
  const time = timeStr || '000000';

  const baseUrl = `https://bullet-ws.hitv.com/bullet/tx/${date}/${time}/${videoId}`;
  const result = [];
  let index = 0;
  let noKeyCount = 0;

  while (true) {
    const url = `${baseUrl}/${index}.json`;
    logger.debug(`[mango] 请求: ${url}`);

    try {
      const res = await axios.get(url, { timeout: 10000 });
      const data = res.data;

      // NoSuchKey 响应
      if (typeof data === 'string' && data.includes('NoSuchKey')) {
        noKeyCount++;
        logger.debug(`[mango] segment ${index}: NoSuchKey (连续${noKeyCount}次)`);
        if (noKeyCount >= 2) break;
        index++;
        continue;
      }

      // 解析 items
      const items = data?.data?.items;
      if (!Array.isArray(items) || items.length === 0) {
        noKeyCount = 0;
        logger.debug(`[mango] segment ${index}: 0 条弹幕`);
        index++;
        continue;
      }

      noKeyCount = 0;
      const sizeKB = (JSON.stringify(data).length / 1024).toFixed(1);
      logger.debug(`[mango] segment ${index}: ${items.length} 条弹幕, ${sizeKB} KB`);

      for (const d of items) {
        if (!d.content) continue;
        let color = '#ffffff';
        const cl = d.v2_color?.color_left;
        if (cl && cl.r >= 0 && cl.g >= 0 && cl.b >= 0) {
          const hex = (c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0');
          color = `#${hex(cl.r)}${hex(cl.g)}${hex(cl.b)}`;
        }
        result.push({
          text: d.content,
          time: d.time / 1000,
          color,
          mode: 'scroll',
        });
      }
    } catch (err) {
      noKeyCount++;
      const status = err.response?.status || err.code;
      logger.debug(`[mango] segment ${index}: 请求失败 (${status})，连续${noKeyCount}次`);
      if (noKeyCount >= 2) break;
      index++;
      continue;
    }

    index++;
  }

  logger.info(`[mango] 完成，共 ${result.length} 条弹幕，${index + 1} 个分片`);
  return result.sort((a, b) => a.time - b.time);
}

module.exports = { fetchMangoDanmaku };
