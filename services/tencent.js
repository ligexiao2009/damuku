const axios = require('axios');
const https = require('https');
const dns = require('dns');
const logger = require('../utils/logger');
const util = require('util');

// 自定义 DNS 解析（绕过慢的 1.1.1.1）
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

// 复用 HTTPS 连接，避免每段重建 TCP+TLS
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10, lookup: fastLookup });

// 将 setTimeout Promise 化
const sleep = util.promisify(setTimeout);

async function fetchTencentDanmaku(vid, durationMs, cookie = '') {
  const step = 30000;
  const totalSegments = Math.ceil(durationMs / step);
  let result = [];

  let emptyCount = 0;

  for (let i = 0; i < totalSegments; i++) {
    const start = i * step;
    const end = start + step;
    // 带重试的请求，最多 3 次，指数退避
    let segmentOk = false;
    let segmentEmpty = false;
    for (let retry = 0; retry < 3 && !segmentOk; retry++) {
      if (retry > 0) {
        const wait = 1000 * Math.pow(2, retry - 1); // 1s → 2s → 4s
        logger.debug(`[tencent] 分段 ${start}-${end} 重试 ${retry}/3，等待 ${wait}ms`);
        await sleep(wait);
      } else {
        await sleep(10);
      }
      try {
        const t0 = Date.now();
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
            httpsAgent: keepAliveAgent,
          }
        );
        const elapsed = Date.now() - t0;

        const list = res.data?.barrage_list || [];
        if (list.length === 0) segmentEmpty = true;
        logger.debug(`[tencent] 分段 ${start}-${end} ${list.length}条 ${elapsed}ms`);
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
        segmentOk = true;
      } catch (err) {
        logger.warn(`[tencent] 分段 ${start}-${end} 请求失败 (${retry+1}/3):`, err.message);
      }
    }
    // 连续 3 段空弹幕 → 已超过视频结尾，停止
    if (segmentOk && segmentEmpty) {
      emptyCount++;
      if (emptyCount >= 3) {
        logger.info(`[tencent] 连续 ${emptyCount} 段空弹幕，已到达视频结尾，停止 (${start}s)`);
        break;
      }
    } else if (segmentOk) {
      emptyCount = 0;
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

module.exports = { fetchTencentDanmaku };
