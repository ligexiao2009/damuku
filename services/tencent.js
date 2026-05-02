const axios = require('axios');
const util = require('util');

// 将 setTimeout Promise 化
const sleep = util.promisify(setTimeout);

async function fetchTencentDanmaku(vid, durationMs) {
  const step = 30000;
  const totalSegments = Math.ceil(durationMs / step);
  let result = [];

  for (let i = 0; i < totalSegments; i++) {
    const start = i * step;
    const end = start + step;
    await sleep(10); // 避免请求过快被封禁
    try {
      const res = await axios.get(
        `https://dm.video.qq.com/barrage/segment/${vid}/t/v1/${start}/${end}`,
        {
          headers: {
            Referer: 'https://v.qq.com/',
            Origin: 'https://v.qq.com',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          timeout: 10000,
        }
      );

      const list = res.data?.barrage_list || [];
      console.log(`[tencent] 分段 ${start}-${end} 获取到 ${list.length} 条弹幕`);
      for (const d of list) {
        if (!d.content) continue;
        let color = '#ffffff';
        try {
          const style = JSON.parse(d.content_style || '{}');
          const gradient = style.gradient_colors;
          const c = (Array.isArray(gradient) && gradient[0]) ? gradient[0] : style.color;
          if (c) color = '#' + c;
        } catch {}
        result.push({
          text: d.content,
          time: d.time_offset / 1000,
          color,
          mode: 'scroll',
          ctime: d.create_time,
        });
      }
    } catch (err) {
      console.error(`[tencent] 分段 ${start}-${end} 请求失败:`, err.message);
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

module.exports = { fetchTencentDanmaku };
