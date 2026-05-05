const fs = require('fs');
const path = require('path');
const { success, fail } = require('../utils/response');
const { getCacheFilePaths } = require('../utils/file');
const { fetchVideoMeta, fetchDanmuXml, fetchDanmuSeg } = require('../services/bilibili');
const { parseDanmu, tryParseDanmuSeg } = require('../services/danmu');
const { fetchTencentDanmaku } = require('../services/tencent');
const { fetchMangoDanmaku } = require('../services/mango');
const { fetchZhibo8Danmaku } = require('../services/zhibo8');
const { fetchTxspDanmaku } = require('../services/txsp');
const logger = require('../utils/logger');
const { DANMU_DIR, META_DIR } = require('../shared/constants');
const { danmuProgressMap } = require('../shared/state');

const router = require('express').Router();

function backupCache(filePath) {
  if (!fs.existsSync(filePath)) return;
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const bak = `${filePath}.bak.${ts}`;
  fs.copyFileSync(filePath, bak);
  logger.info(`📦 备份旧缓存: ${path.basename(bak)}`);
}

function cacheKey(id) {
  return id.toUpperCase().startsWith('BV') ? id : `ep${String(id).replace(/^ep/i, '')}`;
}

/** 用 seg.so 策略加载 B站弹幕（含分段请求、失败重试、进度上报） */
async function fetchBiliSegSo(cacheKey, videoMeta) {
  const segmentCount = Math.min(100, Math.max(1, Math.ceil((videoMeta.duration || 0) / 360)));
  logger.info(`[seg.so] 开始加载弹幕，共 ${segmentCount} 个分段...`);
  logger.timeDebug('[seg.so] 耗时');

  danmuProgressMap.set(cacheKey, { current: 0, total: segmentCount, phase: 'loading' });

  const results = [];
  for (let i = 1; i <= segmentCount; i++) {
    try {
      const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: i });
      results[i - 1] = { status: 'fulfilled', value: buf };
    } catch (err) {
      results[i - 1] = { status: 'rejected', reason: err };
    }
    danmuProgressMap.set(cacheKey, { current: i, total: segmentCount, phase: 'loading' });
    if (i < segmentCount) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const danmus = [];
  const retryIndices = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const parsed = tryParseDanmuSeg(r.value, i + 1);
      if (parsed.length) danmus.push(...parsed);
      else retryIndices.push(i + 1);
    } else {
      retryIndices.push(i + 1);
    }
  });

  if (retryIndices.length) {
    danmuProgressMap.set(cacheKey, { current: 0, total: retryIndices.length, phase: 'retrying' });
    logger.warn(`[seg.so] ${retryIndices.length} 个分段失败，等待5秒后重试...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    for (const idx of retryIndices) {
      try {
        const buf = await fetchDanmuSeg({ cid: videoMeta.cid, aid: videoMeta.aid, segmentIndex: idx });
        const parsed = tryParseDanmuSeg(buf, idx);
        if (parsed.length) {
          danmus.push(...parsed);
          logger.debug(`[seg.so] 分段 ${idx} 重试成功，${parsed.length} 条`);
        } else {
          logger.warn(`[seg.so] 分段 ${idx} 重试仍然失败，已放弃`);
        }
      } catch (err) {
        const retryDetail = err.response ? ` status=${err.response.status} body=${Buffer.from(err.response.data || '').toString('utf-8').slice(0, 200)}` : '';
        logger.warn(`[seg.so] 分段 ${idx} 重试异常: ${err.message}${retryDetail}`);
      }
      danmuProgressMap.set(cacheKey, { current: retryIndices.indexOf(idx) + 1, total: retryIndices.length, phase: 'retrying' });
      if (idx < retryIndices[retryIndices.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  danmuProgressMap.delete(cacheKey);
  logger.timeEndDebug('[seg.so] 耗时');
  logger.info(`[seg.so] 加载完成，共 ${danmus.length} 条弹幕`);
  return danmus;
}

// GET /api/danmu/progress
router.get('/danmu/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少视频ID'));
  const progress = danmuProgressMap.get(cacheKey(id));
  res.json(success(progress || null));
});

// GET /api/danmu — 旧接口，B站专用
router.get('/danmu', async (req, res) => {
  let ck;
  try {
    const { id } = req.query;
    const requestedStrategy = req.query.strategy === 'seg.so' ? 'seg.so' : 'xml';
    const forceRefresh = req.query.refresh === '1';

    if (!id) return res.status(400).json(fail(400, '缺少视频ID'));
    ck = cacheKey(id);
    const [cacheFile] = getCacheFilePaths(ck, requestedStrategy, DANMU_DIR);

    if (!forceRefresh && fs.existsSync(cacheFile)) {
      return res.json(success({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true }));
    }
    logger.info('Fetching danmu for ID:', id, 'Strategy:', requestedStrategy, 'Force Refresh:', forceRefresh);
    const videoMeta = await fetchVideoMeta(id, META_DIR);

    let danmus;
    let strategy = requestedStrategy;

    if (requestedStrategy === 'seg.so') {
      danmus = await fetchBiliSegSo(ck, videoMeta);
    } else {
      logger.timeDebug('[xml] 耗时');
      const xml = await fetchDanmuXml(videoMeta.cid);
      danmus = parseDanmu(xml);
      logger.timeEndDebug('[xml] 耗时');
      logger.info(`[xml] 加载完成，共 ${danmus.length} 条弹幕`);
    }

    const cacheFileFinal = getCacheFilePaths(ck, strategy, DANMU_DIR)[0];
    const result = { strategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
    backupCache(cacheFileFinal);
    fs.writeFileSync(cacheFileFinal, JSON.stringify(result, null, 2));
    res.json(success(result));
  } catch (err) {
    danmuProgressMap.delete(ck);
    res.status(500).json(fail(500, err.message));
  }
});

// GET /api/danmaku — 统一弹幕接口，支持多源
router.get('/danmaku', async (req, res) => {
  try {
    const { source, id, duration } = req.query;
    if (!source) return res.status(400).json(fail(400, '缺少 source 参数'));

    // 腾讯
    if (source === 'qq') {
      const vid = id;
      const durMs = Number(duration) || 3600000;
      const forceRefresh = req.query.refresh === '1';
      const cacheFile = path.join(DANMU_DIR, `qq_${vid}.json`);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        return res.json(success({ ...cached, fromCache: true }));
      }

      logger.info(`[tencent] 抓取弹幕 VID: ${vid} 时长: ${(durMs / 60000).toFixed(1)}分钟`);
      logger.timeDebug('[tencent] 耗时');
      const danmus = await fetchTencentDanmaku(vid, durMs);
      logger.timeEndDebug('[tencent] 耗时');
      logger.info(`[tencent] 完成，共 ${danmus.length} 条`);

      const result = { source: 'qq', id: vid, count: danmus.length, danmus };
      backupCache(cacheFile);
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // B站
    if (source === 'bili') {
      const requestedStrategy = req.query.strategy === 'xml' ? 'xml' : 'seg.so';
      const forceRefresh = req.query.refresh === '1';
      const ck = cacheKey(id);
      const [cacheFile] = getCacheFilePaths(ck, requestedStrategy, DANMU_DIR);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        return res.json(success({ ...JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), fromCache: true }));
      }

      logger.info('Fetching danmu for ID:', id, 'Strategy:', requestedStrategy);
      const videoMeta = await fetchVideoMeta(id, META_DIR);
      let danmus;

      if (requestedStrategy === 'seg.so') {
        danmus = await fetchBiliSegSo(ck, videoMeta);
      } else {
        logger.timeDebug('[xml] 耗时');
        const xml = await fetchDanmuXml(videoMeta.cid);
        danmus = parseDanmu(xml);
        logger.timeEndDebug('[xml] 耗时');
        logger.info(`[xml] 完成，共 ${danmus.length} 条`);
      }

      const cacheFileFinal = getCacheFilePaths(ck, requestedStrategy, DANMU_DIR)[0];
      const result = { source: 'bili', strategy: requestedStrategy, id, cid: videoMeta.cid, count: danmus.length, danmus };
      backupCache(cacheFileFinal);
      fs.writeFileSync(cacheFileFinal, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // 芒果TV
    if (source === 'mango') {
      const parts = id.split('/');
      const timeStr = parts[0] || '000000';
      const videoId = parts[1] || id;
      const forceRefresh = req.query.refresh === '1';
      const cacheFile = path.join(DANMU_DIR, `mango_${timeStr}_${videoId}.json`);

      if (!forceRefresh && fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        return res.json(success({ ...cached, fromCache: true }));
      }

      logger.info(`[mango] 抓取弹幕 videoId: ${videoId} time: ${timeStr}`);
      logger.timeDebug('[mango] 耗时');
      const danmus = await fetchMangoDanmaku(videoId, undefined, timeStr);
      logger.timeEndDebug('[mango] 耗时');

      const result = { source: 'mango', id: videoId, count: danmus.length, danmus };
      backupCache(cacheFile);
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(success(result));
    }

    // 直播吧
    if (source === 'zhibo8') {
      const matchId = (id || '');
      const type = req.query.type || 'zuqiu';
      const lastMaxId = Number(req.query.lastMaxId) || 0;
      logger.debug(`[zhibo8] 查询弹幕 matchId: ${matchId} type: ${type} lastMaxId: ${lastMaxId}`);
      const { danmus, maxId } = await fetchZhibo8Danmaku(matchId, type, lastMaxId);
      return res.json(success({ source: 'zhibo8', id: matchId, count: danmus.length, danmus, maxId }));
    }

    // 腾讯体育
    if (source === 'txsp') {
      const roomId = req.query.roomId || '';
      const programId = req.query.programId || '';
      const lastSeq = Number(req.query.lastSeq) || 0;
      const cursor = req.query.cursor || '';
      if (!roomId || !programId) return res.status(400).json(fail(400, '缺少 roomId 或 programId'));
      const txspCookie = req.query.txspCookie || process.env.TXSP_COOKIE || '';
      const cookieSource = req.query.txspCookie ? 'client' : (process.env.TXSP_COOKIE ? 'env' : 'none');
      const cookieHash = txspCookie ? `[${cookieSource}: ${txspCookie.slice(0,16)}...${txspCookie.slice(-8)}]` : '(无)';
      logger.info(`[txsp] roomId=${roomId} programId=${programId} cookie=${cookieHash} lastSeq=${lastSeq}`);
      if (txspCookie) logger.debug(`[txsp] cookie 完整值 (${txspCookie.length} 字符): ${txspCookie}`);
      const { danmus, maxSeq, cursor: nextCursor, pullInterval } = await fetchTxspDanmaku(roomId, programId, lastSeq, cursor, txspCookie);
      return res.json(success({ source: 'txsp', id: `${roomId}_${programId}`, count: danmus.length, danmus, maxSeq, cursor: nextCursor, pullInterval }));
    }

    return res.status(400).json(fail(400, '不支持的弹幕源，可选: bili, qq, mango, zhibo8, txsp'));
  } catch (err) {
    logger.error(`[${req.query.source}] 弹幕请求失败:`, err.message);
    const { id, source } = req.query;
    if (source === 'bili') danmuProgressMap.delete(cacheKey(id || ''));
    res.status(500).json(fail(500, err.message));
  }
});

module.exports = router;
