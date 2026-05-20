const axios = require('axios');
const logger = require('../utils/logger');

const API_URL = 'https://zbpbaccess.video.qq.com/trpc.live_main_logic.live_danmu_read.LiveDanmuRead/PullMsgH5?vappid=34382579&vsecret=e496b057758aeb04b3a2d623c952a1c47e04ffb0a01e19cf';

function safeGet(obj, path, fallback = null) {
  try {
    return path.split('.').reduce((o, key) => o?.[key], obj) ?? fallback;
  } catch { return fallback; }
}

async function fetchTxspDanmaku(roomId, programId, lastSeq = 0, cursor = '', reqCookie = '') {
  logger.debug(`📡 [txsp] 请求 roomId=${roomId} programId=${programId} lastSeq=${lastSeq}`);

  // Filter to only essential cookies, avoid expired/conflicting ones
  if (reqCookie) {
    const essential = ['video_guid', 'vuserid', 'vusession', 'v_vusession', 'qq_domain_video_guid_verify'];
    reqCookie = reqCookie.split(';')
      .filter(p => essential.includes(p.trim().split('=')[0]))
      .join('; ');
  }

  const res = await axios.post(API_URL, {
    room_id: Number(roomId),
    cookie: cursor,
    program_id: String(programId),
  }, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=utf-8',
      Referer: 'https://v.qq.com/',
      Cookie: reqCookie,
    },
    timeout: 15000,
  });

  const root = res.data?.data?.data;
  if (!root) {
    logger.warn(`⚠️ [txsp] 接口返回异常:`, JSON.stringify(res.data).slice(0, 200));
    return { danmus: [], maxSeq: lastSeq, cursor: '', pullInterval: 5000 };
  }

  const nextCursor = root.cookie || cursor;
  const pullInterval = root.pull_interval || 5000;

  const allMsgs = [
    ...(root.nonconst_speed_msg_info || []),
    ...(root.const_speed_msg_info || []),
  ];

  const newItems = [];
  let maxSeq = lastSeq;

  for (const item of allMsgs) {
    const seq = Number(item.msg_seq || 0);
    if (seq <= lastSeq) continue;

    const danmu = safeGet(item, 'broad_cast.msg_content.danmuku_info');
    if (!danmu) continue;

    const text = safeGet(danmu, 'content.content_v2', '');
    if (!text) continue;

    const imageMap = safeGet(danmu, 'res.image_infos', {});
    if (imageMap[text]) continue;

    newItems.push({
      text,
      time: 0,
      color: '#ffffff',
      mode: 1,
      ctime: safeGet(danmu, 'danmaku_control_info.post_time', 0),
    });

    if (seq > maxSeq) maxSeq = seq;
  }

  logger.debug(`💬 [txsp] 新增 ${newItems.length} 条弹幕 (maxSeq=${maxSeq})`);
  return { danmus: newItems, maxSeq, cursor: nextCursor, pullInterval };
}

module.exports = { fetchTxspDanmaku };
