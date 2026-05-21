const axios = require('axios');
const https = require('https');
const dns = require('dns');
const logger = require('../utils/logger');

const FAST_DNS = '114.114.114.114';
const dnsCache = new Map();
const resolver = new dns.Resolver();
resolver.setServers([FAST_DNS]);
const origLookup = dns.lookup;

function fastLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiry > Date.now()) {
    if (opts.all) return cb(null, [{ address: cached.ip, family: 4 }]);
    return cb(null, cached.ip, 4);
  }
  resolver.resolve4(hostname, (err, ips) => {
    if (err || !ips.length) return origLookup(hostname, opts, cb);
    dnsCache.set(hostname, { ip: ips[0], expiry: Date.now() + 300000 });
    if (opts.all) return cb(null, [{ address: ips[0], family: 4 }]);
    cb(null, ips[0], 4);
  });
}

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10, lookup: fastLookup });

const API_URL = 'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage';
const VIDEO_APPID = '3000010';
const VERSION_NAME = '8.5.96';

function randomGuid() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function fetchTencentVideoDetail(cid, vid = '') {
  const deviceGuid = randomGuid();

  const pageParams = { req_from: 'web_vsite' };
  if (vid) pageParams.vid = vid;
  if (cid) pageParams.cid = cid;  // 无 cid 时只传 vid，拿单视频正确信息

  const body = {
    page_params: pageParams,
    page_bypass_params: {
      params: { caller_id: VIDEO_APPID, platform_id: '2' },
      scene: 'desk_detail',
      abtest_bypass_id: deviceGuid,
    },
    page_context: {},
  };

  const url = `${API_URL}?vdevice_guid=${deviceGuid}&video_appid=${VIDEO_APPID}&vversion_name=${VERSION_NAME}&vversion_platform=2`;

  logger.debug(`[tencent_detail] 请求 CID: ${cid}`);

  const res = await axios.post(url, body, {
    headers: {
      Referer: 'https://v.qq.com/',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    timeout: 15000,
    httpsAgent: keepAliveAgent,
  });

  const cardList = res.data?.data?.CardList;
  if (!cardList) {
    logger.warn(`[tencent_detail] 接口返回空数据: ret=${res.data?.ret}`);
    return null;
  }

  const detail = parseCardList(cardList);
  logger.debug(`[tencent_detail] 解析完成: ${detail.title}, ${detail.episodes.length}集`);
  return detail;
}

function parseCardList(cardList) {
  const result = {
    title: '',
    description: '',
    poster: '',
    verticalPoster: '',
    year: '',
    area: '',
    genres: [],
    plotTags: '',
    episodeAll: 0,
    hotval: '',
    score: '',
    doubanScore: '',
    imdbId: '',
    broadcastTime: '',
    cast: [],
    directors: [],
    episodes: [],
  };

  function walkCards(cards) {
    for (const card of cards) {
      const ctype = card.type;
      const params = card.params || {};

      // --- 简介 ---
      if (ctype === 'pc_introduction') {
        result.title = params.title || result.title;
        result.description = params.cover_description || result.description;
        result.poster = params.new_pic_hz || result.poster;
        result.verticalPoster = params.new_pic_vt || result.verticalPoster;
        result.year = params.year || result.year;
        result.area = params.area_name || result.area;
        result.episodeAll = parseInt(params.episode_all, 10) || result.episodeAll;
        result.hotval = params.hotval || result.hotval;
        result.broadcastTime = params.broadcast_time || result.broadcastTime;

        const mainGenre = params.main_genres;
        if (mainGenre) result.genres.push(mainGenre);
        const subGenres = (params.sub_genre || '').split(',').filter(Boolean);
        result.genres.push(...subGenres);
        result.genres = [...new Set(result.genres)];

        try {
          const si = JSON.parse(params.score_info || '{}');
          result.score = si.video_score || result.score || '';
          result.doubanScore = si.douban_score || result.doubanScore || '';
          result.imdbId = si.imdb_id || result.imdbId || '';
        } catch {}

        try {
          const mi = JSON.parse(params.matrix_infos || '{}');
          result.plotTags = mi.plot_point_info || result.plotTags || '';
        } catch {}
      }

      // --- 演员 & 导演 ---
      if (ctype === 'pad_star_introduction') {
        for (const ck of Object.keys(card.children_list || {})) {
          for (const sc of (card.children_list[ck].cards || [])) {
            const p = sc.params || {};
            const name = p.star_name;
            const label = p.star_role_label || '';
            if (!name) continue;
            const person = { name, avatar: p.star_pic || '' };
            if (label.includes('导演')) {
              person.role = label;
              result.directors.push(person);
            } else if (label.includes('编剧')) {
              person.role = label;
              if (!result.directors.find(d => d.name === name)) result.directors.push(person);
            } else if (label.startsWith('饰')) {
              person.role = label.replace(/^饰\s*/, '');
              result.cast.push(person);
            }
          }
        }
      }

      // --- 评分 ---
      if (ctype === 'detail_score_discussion_style') {
        result.score = result.score || params.score || '';
        result.doubanScore = result.doubanScore || params.douban_rating || '';
      }

      // --- 分集 ---
      if (ctype === 'pc_web_episode_list') {
        const epData = [];
        function collectEps(cards) {
          for (const c of cards) {
            const p = c.params || {};
            if (p.vid) {
              epData.push({
                title: p.title || '',
                vid: p.vid,
                duration: parseInt(p.duration, 10) || 0,
                episode: parseInt(p.episode, 10) || 0,
                publishDate: p.publish_date || '',
              });
            }
          }
        }
        // 第一层 children
        const children = card.children_list || {};
        for (const ck of Object.keys(children)) {
          collectEps(children[ck].cards || []);
        }
        if (epData.length) result.episodes = epData;
      }

      // 递归子 card
      const children = card.children_list || {};
      for (const ck of Object.keys(children)) {
        walkCards(children[ck].cards || []);
      }
    }
  }

  walkCards(cardList);
  return result;
}

async function fetchCidByVid(vid) {
  logger.debug(`[tencent_detail] 从 VID 反查 CID: ${vid}`);

  const res = await axios.get(`https://v.qq.com/x/page/${vid}.html`, {
    headers: {
      Referer: 'https://v.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    timeout: 10000,
    httpsAgent: keepAliveAgent,
  });

  const html = typeof res.data === 'string' ? res.data : String(res.data);
  const match = html.match(/cid["\s:=]+([a-z0-9]{10,16})/);
  if (match) {
    logger.debug(`[tencent_detail] VID ${vid} → CID ${match[1]}`);
    return match[1];
  }

  logger.warn(`[tencent_detail] 未能从 VID ${vid} 提取 CID`);
  return null;
}

module.exports = { fetchTencentVideoDetail, fetchCidByVid };
