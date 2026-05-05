/**
 * Tencent Sports Live Danmaku Fetcher
 * -----------------------------------
 * 功能：
 * - 请求腾讯直播弹幕接口
 * - 自动维护cursor(cookie)
 * - 解析：
 *    1. 普通弹幕
 *    2. 表情弹幕
 *    3. 用户入场
 *    4. 点赞
 * - 控制台实时输出
 *
 * 安装：
 * npm install axios
 */

const axios = require("axios");

const API_URL =
  "https://zbpbaccess.video.qq.com/trpc.live_main_logic.live_danmu_read.LiveDanmuRead/PullMsgH5?vappid=34382579&vsecret=e496b057758aeb04b3a2d623c952a1c47e04ffb0a01e19cf";

// ----------------------------
// 配置区域
// ----------------------------
const ROOM_ID = 1532348367;
const PROGRAM_ID = "366787";

// 浏览器抓包中的cookie（首次请求建议完整带上）
// 后续body中的cursor会自动更新
const REQUEST_COOKIE = `
qq_domain_video_guid_verify=f983f47e3709e4d0;
video_platform=2;
video_guid=f983f47e3709e4d0;
pgv_pvid=2444592250;
tvfe_boss_uuid=77b47531987ce9f0;
`.replace(/\s+/g, " ").trim();

// 初始cursor（可为空）
let cursor = "";

// 去重缓存
const seen = new Set();

// ----------------------------
// 工具函数
// ----------------------------
function safeGet(obj, path, fallback = null) {
  try {
    return path.split(".").reduce((o, key) => o?.[key], obj) ?? fallback;
  } catch {
    return fallback;
  }
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(Number(ts) * 1000).toLocaleString("zh-CN");
}

// ----------------------------
// 消息解析
// ----------------------------
function parseDanmu(item) {
  const danmu = safeGet(item, "broad_cast.msg_content.danmuku_info");
  if (!danmu) return null;

  const text = safeGet(danmu, "content.content_v2", "");
  const imageMap = safeGet(danmu, "res.image_infos", {});
  const imageUrl = imageMap[text] || null;

  return {
    category: "danmu",
    seq: item.msg_seq,
    user: safeGet(danmu, "user_info.user_name", "未知用户"),
    uid: safeGet(danmu, "user_info.account_info.account_id", ""),
    text,
    timestamp: safeGet(danmu, "danmaku_control_info.post_time", 0),
    time: formatTime(safeGet(danmu, "danmaku_control_info.post_time", 0)),
    type: danmu.type,
    imageUrl,
  };
}

function parseEnter(item) {
  const enter = item.user_enter_room;
  if (!enter) return null;

  return {
    category: "enter",
    seq: item.msg_seq,
    user: safeGet(enter, "user_info.nick", "游客"),
    uid: safeGet(enter, "user_info.uid", ""),
    timestamp: safeGet(enter, "user_info.enter_ts", 0),
    time: formatTime(safeGet(enter, "user_info.enter_ts", 0)),
    popularity: enter.harvest || 0,
  };
}

function parseLike(item) {
  const like = item.like_msg;
  if (!like) return null;

  return {
    category: "like",
    seq: item.msg_seq,
    user: like.user_nick || "",
    totalLikes: Number(like.total_free_love_num || 0),
  };
}

function parseMessage(item) {
  if (seen.has(item.msg_seq)) return null;
  seen.add(item.msg_seq);

  switch (item.msg_id) {
    case 33:
      return parseDanmu(item);

    case 200:
      return parseEnter(item);

    case 48:
      return parseLike(item);

    default:
      return null;
  }
}

// ----------------------------
// 输出处理
// ----------------------------
function outputMessage(msg) {
  if (!msg) return;

  switch (msg.category) {
    case "danmu":
      if (msg.imageUrl) {
        console.log(
          `[弹幕表情] [${msg.time}] ${msg.user}: ${msg.text} (${msg.imageUrl})`
        );
      } else {
        console.log(`[弹幕] [${msg.time}] ${msg.user}: ${msg.text}`);
      }
      break;

    case "enter":
    //   console.log(
    //     `[入场] [${msg.time}] ${msg.user} 进入直播间 | 热度:${msg.popularity}`
    //   );
      break;

    case "like":
    //   console.log(
    //     `[点赞] ${msg.user} 点赞 | 总点赞:${msg.totalLikes}`
    //   );
      break;
  }
}

// ----------------------------
// 拉取函数
// ----------------------------
async function pullDanmu() {
  try {
    const response = await axios.post(
      API_URL,
      {
        room_id: ROOM_ID,
        cookie: cursor,
        program_id: PROGRAM_ID,
      },
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json;charset=utf-8",
          Referer: "https://v.qq.com/",
          Cookie: REQUEST_COOKIE,
        },
        timeout: 15000,
      }
    );

    const root = response.data?.data?.data;

    if (!root) {
      console.log("接口返回异常:", response.data);
      scheduleNext(5000);
      return;
    }

    // 更新cursor
    cursor = root.cookie || cursor;

    // 官方建议轮询间隔
    const interval = root.pull_interval || 5000;

    // 普通消息
    const dynamicMsgs = root.nonconst_speed_msg_info || [];
    dynamicMsgs.forEach((item) => {
      const parsed = parseMessage(item);
      outputMessage(parsed);
    });

    // 固定速率消息（点赞）
    const staticMsgs = root.const_speed_msg_info || [];
    staticMsgs.forEach((item) => {
      const parsed = parseMessage(item);
      outputMessage(parsed);
    });

    scheduleNext(interval);
  } catch (err) {
    console.error("请求失败:", err.message);
    scheduleNext(5000);
  }
}

// ----------------------------
// 调度
// ----------------------------
function scheduleNext(ms) {
  setTimeout(() => {
    pullDanmu();
  }, ms);
}

// ----------------------------
// 启动
// ----------------------------
console.log("腾讯体育直播弹幕监听启动...");
pullDanmu();