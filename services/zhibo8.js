const axios = require('axios');

const rand = () => Math.random().toString();

// 按 matchId 维护轮询状态
const stateMap = new Map();

function getStateKey(matchId, type) {
  return `${type}_${matchId}`;
}

async function fetchCount(matchId, type) {
  const url = `https://dan.zhibo8.cc/data/2026/${type}/match${matchId}v_count.htm?rand=${rand()}`;
  console.log(`📡 [zhibo8] FETCH count: ${url}`);
  const res = await axios.get(url, {
    headers: { referer: 'https://www.zhibo8.com/', 'user-agent': 'Mozilla/5.0' },
  });
  console.log(`📡 [zhibo8] COUNT res:`, JSON.stringify(res.data));
  return res.data;
}

async function fetchPage(matchId, type, page) {
  const url = `https://dan.zhibo8.cc/data/2026/${type}/match${matchId}v_${page}.htm?rand=${rand()}`;
  console.log(`📦 [zhibo8] FETCH page: ${url}`);
  const res = await axios.get(url, {
    headers: { referer: 'https://www.zhibo8.com/', 'user-agent': 'Mozilla/5.0' },
  });
  console.log(`📦 [zhibo8] PAGE res: ${Array.isArray(res.data) ? res.data.length + ' items' : JSON.stringify(res.data).slice(0, 200)}`);
  return res.data;
}

/**
 * 获取增量弹幕（每次调用只返回上次之后新增的）
 * @param {string} matchId - 比赛ID
 * @param {string} type - 比赛类型: zuqiu | nba | other
 */
async function fetchZhibo8Danmaku(matchId, type = 'zuqiu') {
  const key = getStateKey(matchId, type);
  if (!stateMap.has(key)) {
    stateMap.set(key, { lastNum: 0, lastMaxId: 0, perPage: 5 });
  }

  const state = stateMap.get(key);

  const countData = await fetchCount(matchId, type);
  const num = Number(countData.num || 0);
  const perPage = Number(countData.per_page || 5);
  state.perPage = perPage;

  console.log(`📊 [zhibo8] type=${type} num=${num} perPage=${perPage} lastNum=${state.lastNum}`);

  if (num === state.lastNum) return [];

  const page = Math.ceil(num / perPage) - 1;
  console.log(`➡️ [zhibo8] num变化: ${state.lastNum} → ${num} | page=${page}`);
  state.lastNum = num;

  const list = await fetchPage(matchId, type, page);
  if (!Array.isArray(list)) {
    console.log(`⚠️ [zhibo8] PAGE 返回值不是数组:`, typeof list);
    return [];
  }

  const newItems = [];
  for (const item of list) {
    const id = Number(item.id);
    if (id > state.lastMaxId) {
      newItems.push({
        text: String(item.content || ''),
        time: 0,
        color: '#ffffff',
        mode: 1,
        rawTime: item.createtime,
      });
      if (id > state.lastMaxId) state.lastMaxId = id;
    }
  }

  console.log(`💬 [zhibo8] 新增 ${newItems.length} 条弹幕 (lastMaxId=${state.lastMaxId})`);
  return newItems;
}

module.exports = { fetchZhibo8Danmaku };
