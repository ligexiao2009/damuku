const axios = require('axios');

const rand = () => Math.random().toString();

async function fetchCount(matchId, type) {
  const url = `https://dan.zhibo8.cc/data/2026/${type}/${matchId}_count.htm?rand=${rand()}`;
  console.log(`📡 [zhibo8] FETCH count: ${url}`);
  const res = await axios.get(url, {
    headers: { referer: 'https://www.zhibo8.com/', 'user-agent': 'Mozilla/5.0' },
  });
  console.log(`📡 [zhibo8] COUNT res:`, JSON.stringify(res.data));
  return res.data;
}

async function fetchPage(matchId, type, page) {
  const url = `https://dan.zhibo8.cc/data/2026/${type}/${matchId}_${page}.htm?rand=${rand()}`;
  console.log(`📦 [zhibo8] FETCH page: ${url}`);
  const res = await axios.get(url, {
    headers: { referer: 'https://www.zhibo8.com/', 'user-agent': 'Mozilla/5.0' },
  });
  console.log(`📦 [zhibo8] PAGE res: ${Array.isArray(res.data) ? res.data.length + ' items' : JSON.stringify(res.data).slice(0, 200)}`);
  return res.data;
}

/**
 * 获取最新页弹幕，由客户端传入 lastMaxId 做去重。
 * 服务端不存状态，多客户端各自独立。
 * @param {string} matchId - 比赛ID
 * @param {string} type - 比赛类型: zuqiu | nba | other
 * @param {number} lastMaxId - 客户端上次收到的最大 id
 */
async function fetchZhibo8Danmaku(matchId, type = 'zuqiu', lastMaxId = 0) {
  const countData = await fetchCount(matchId, type);
  const num = Number(countData.num || 0);
  const perPage = Number(countData.per_page || 5);

  if (num <= 0) return { danmus: [], maxId: lastMaxId };

  const page = Math.ceil(num / perPage) - 1;
  console.log(`📊 [zhibo8] type=${type} num=${num} perPage=${perPage} page=${page} lastMaxId=${lastMaxId}`);

  const list = await fetchPage(matchId, type, page);
  if (!Array.isArray(list)) {
    console.log(`⚠️ [zhibo8] PAGE 返回值不是数组:`, typeof list);
    return [];
  }

  const newItems = [];
  let maxId = lastMaxId;
  for (const item of list) {
    const id = Number(item.id);
    if (id > lastMaxId) {
      const room = Number(item.room || 1);
      newItems.push({
        text: String(item.content || ''),
        time: 0,
        color: room === 2 ? '#ffcc00' : '#ffffff',
        mode: 1,
        rawTime: item.createtime,
        room,
      });
      if (id > maxId) maxId = id;
    }
  }

  console.log(`💬 [zhibo8] 新增 ${newItems.length} 条弹幕 (maxId=${maxId})`);
  return { danmus: newItems, maxId };
}

module.exports = { fetchZhibo8Danmaku };
