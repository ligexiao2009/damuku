const axios = require("axios");

const MATCH_ID = 1975991;

let PER_PAGE = 5;

// 状态记录
let lastNum = 0;
let lastMaxId = 0;

const rand = () => Math.random().toString();


// =====================
// 获取 count（状态接口）
// =====================
async function fetchCount() {
  const url = `https://dan.zhibo8.cc/data/2026/zuqiu/match${MATCH_ID}v_count.htm?rand=${rand()}`;

  console.log(`📡 [COUNT] ${url}`);

  const res = await axios.get(url, {
    headers: {
      referer: "https://www.zhibo8.com/",
      "user-agent": "Mozilla/5.0",
    },
  });

  return res.data;
}


// =====================
// 获取分页弹幕
// =====================
async function fetchPage(page) {
  const url = `https://dan.zhibo8.cc/data/2026/zuqiu/match${MATCH_ID}v_${page}.htm?rand=${rand()}`;

  console.log(`📦 [PAGE] ${url}`);

  const res = await axios.get(url, {
    headers: {
      referer: "https://www.zhibo8.com/",
      "user-agent": "Mozilla/5.0",
    },
  });

  return res.data;
}


// =====================
// 主循环
// =====================
async function loop() {
  try {
    const data = await fetchCount();

    const num = Number(data.num || 0);
    PER_PAGE = Number(data.per_page || 5);

    console.log(`📊 num=${num} perPage=${PER_PAGE}`);

    // 🔥 关键：num 没变化就不处理
    if (num === lastNum) return;

    const page = Math.ceil(num / PER_PAGE)-1;

    console.log(`➡️ num变化: ${lastNum} → ${num} | page=${page}`);

    lastNum = num;

    const list = await fetchPage(page);

    if (!Array.isArray(list)) return;

    for (const item of list) {
      const id = Number(item.id);

      if (id > lastMaxId) {
        console.log(`💬 [${item.createtime}] ${item.content}`);
        lastMaxId = id;
      }
    }

  } catch (err) {
    console.log("❌ ERROR:", err.message);
  }
}


// =====================
// 启动轮询
// =====================
setInterval(loop, 2000);

console.log("🚀 Zhibo8 实时弹幕系统启动（num驱动版）");