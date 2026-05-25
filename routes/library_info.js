const fs = require('fs');
const path = require('path');
const { success, fail } = require('../utils/response');
const { isVideoExt } = require('../utils/file');
const { detectVidsFromName, detectIqiyiTvidFromName } = require('../utils/video');
const { fetchTencentVideoDetail, fetchCidByVid } = require('../services/tencent_detail');
const bili = require('../services/bilibili');
const { FOLDERS_BASE, FOLDERS_BASES, META_DIR } = require('../shared/constants');
const { resolveLibraryDirectory, isPathValidationError, scanFolders, hasDirectVideoFiles } = require('../shared/helpers');
const axios = require('axios');
const logger = require('../utils/logger');

const router = require('express').Router();

// 缓存过期时间：7 天
const CACHE_TTL = 7 * 86400000;

function getCachePath(key) {
  return path.join(META_DIR, `${key}.json`);
}

function readCache(key) {
  try {
    const p = getCachePath(key);
    if (!fs.existsSync(p)) return null;
    const cached = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (cached._ts && Date.now() - cached._ts > CACHE_TTL) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    fs.mkdirSync(META_DIR, { recursive: true });
    fs.writeFileSync(getCachePath(key), JSON.stringify({ ...data, _ts: Date.now() }));
  } catch {}
}

/**
 * 根据文件夹名和文件名检测平台和 ID，然后拉元数据
 */
async function detectAndFetch(folderPath, folderName, forceRefresh = false) {
  let videoFiles = [];
  try {
    videoFiles = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.') && isVideoExt(e.name))
      .map(e => e.name);
  } catch { return null; }

  if (!videoFiles.length) return null;

  // 尝试腾讯：提取第一个带 vid 的文件
  for (const f of videoFiles) {
    const vids = detectVidsFromName(f);
    if (vids.length) {
      const cacheKey = `tx_${vids[0]}`;
      const cached = !forceRefresh ? readCache(cacheKey) : null;
      if (cached) return { ...cached, fromCache: true, localFiles: videoFiles, source: 'tencent' };

      const cid = await fetchCidByVid(vids[0]);
      if (cid) {
        const detail = await fetchTencentVideoDetail(cid, vids[0]);
        if (detail) {
          // 用豆瓣补充评分、简介、演员
          let doubanRating = '';
          if (detail.title) {
            try {
              const sr = await searchDouban(detail.title);
              if (sr) {
                detail.doubanScore = sr.rating || detail.doubanScore;
                detail.doubanRatingCount = sr.ratingCount;
                detail.doubanUrl = sr.url;
                // 用摘要或详情补全简介/演员
                if (sr.abstract && !detail.description) detail.description = sr.abstract;
                if (sr.subjectId) {
                  const dd = await fetchDoubanDetail(sr.subjectId);
                  if (dd) {
                    if (dd.description && (!detail.description || dd.description.length > detail.description.length)) detail.description = dd.description;
                    if (dd.directors.length) detail.directors = dd.directors;
                    if (dd.cast.length) detail.cast = dd.cast;
                  }
                }
              }
            } catch {}
          }
          const result = { ...detail, localFiles: videoFiles, source: 'tencent' };
          writeCache(cacheKey, result);
          return { ...result, fromCache: false };
        }
      }
      break;
    }
  }

  // 尝试爱奇艺
  for (const f of videoFiles) {
    const tvid = detectIqiyiTvidFromName(f);
    if (tvid) {
      const cacheKey = `iqiyi_${tvid}`;
      const cached = !forceRefresh ? readCache(cacheKey) : null;
      if (cached) return { ...cached, fromCache: true, localFiles: videoFiles, source: 'iqiyi' };

      try {
        const infoResp = await axios.get(
          `https://pcw-api.iqiyi.com/video/video/baseinfo/${tvid}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }
        );
        const albumId = infoResp.data?.data?.albumId;
        if (albumId) {
          const albumResp = await axios.get(
            `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${albumId}&page=1&size=200`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }
          );
          const eps = albumResp.data?.data?.epsodelist || [];
          const albumImage = infoResp.data?.data?.albumImageUrl || '';
          const title = eps[0]?.name?.replace(/第\d+集/, '') || folderName;
          const epList = eps.map(e => ({
            title: String(e.order || ''),
            tvId: String(e.tvId || ''),
            duration: e.duration || '',
          }));

          const result = {
            title,
            poster: albumImage || eps[0]?.imageUrl || '',
            year: eps[0]?.period?.slice(0, 4) || '',
            episodeAll: eps.length,
            genres: (infoResp.data?.data?.categories || []).map(c => c.name),
            description: eps[0]?.description || infoResp.data?.data?.description || '',
            cast: (infoResp.data?.data?.people?.main_charactor || []).map(c => ({
              name: c.name,
              role: (c.character || [])[0] || '',
              avatar: c.image_url || '',
            })),
            directors: (() => {
              const seen = new Set();
              const list = [];
              for (const d of [...(infoResp.data?.data?.people?.director || []), ...(eps[0]?.people?.director || [])]) {
                if (!seen.has(d.name)) { seen.add(d.name); list.push({ name: d.name, role: '导演' }); }
              }
              return list;
            })(),
            score: '',
            doubanScore: '',
            episodes: epList,
            localFiles: videoFiles,
            source: 'iqiyi',
          };

          // 豆瓣补充评分、海报、简介、演员
          if (result.title) {
            try {
              const sr = await searchDouban(result.title);
              if (sr) {
                result.doubanScore = sr.rating || '';
                result.doubanRatingCount = sr.ratingCount;
                result.doubanUrl = sr.url;
                if (sr.cover) result.poster = sr.cover;
                if (sr.abstract && !result.description) result.description = sr.abstract;
                if (sr.subjectId) {
                  const dd = await fetchDoubanDetail(sr.subjectId);
                  if (dd) {
                    if (dd.description && (!result.description || dd.description.length > result.description.length)) result.description = dd.description;
                    if (dd.directors.length && !result.directors?.length) result.directors = dd.directors;
                    if (dd.cast.length && !result.cast?.length) result.cast = dd.cast;
                  }
                }
              }
            } catch {}
          }

          writeCache(cacheKey, result);
          return { ...result, fromCache: false };
        }
      } catch (err) {
        logger.warn(`[library_info] iqiyi fetch failed for ${tvid}:`, err.message);
      }
      break;
    }
  }

  // 尝试 B站（BV 号或 EP 号）—— 每集单独获取元数据
  const biliIds = [];
  for (const f of videoFiles) {
    const bv = (f.match(/BV[0-9A-Za-z]+/i) || [])[0];
    const ep = (f.match(/ep(\d{4,})/i) || [])[1];
    if (bv || ep) biliIds.push({ file: f, id: bv || ep });
  }
  if (biliIds.length > 0) {
    const cacheKey = `bili_${folderName}`;
    const cached = !forceRefresh ? readCache(cacheKey) : null;
    if (cached) return { ...cached, fromCache: true, localFiles: videoFiles, source: 'bili' };

    let folderPoster = '';
    const epList = [];
    for (const { file, id } of biliIds) {
      try {
        const bmeta = await bili.fetchVideoMeta(id, META_DIR);
        const cover = (bmeta?.cover || '').replace('http://', 'https://');
        if (!folderPoster) folderPoster = cover;
        epList.push({
          title: bmeta?.title || file.replace(/\.[^.]+$/, ''),
          bvId: id,
          poster: cover,
          duration: bmeta?.duration || 0,
        });
      } catch {
        epList.push({ title: file.replace(/\.[^.]+$/, ''), bvId: id, poster: '', duration: 0 });
      }
    }

    const result = {
      title: folderName,
      poster: folderPoster,
      year: '',
      episodeAll: epList.length,
      genres: [],
      description: '',
      cast: [],
      directors: [],
      score: '',
      doubanScore: '',
      episodes: epList,
      localFiles: videoFiles,
      source: 'bili',
    };
    writeCache(cacheKey, result);
    return { ...result, fromCache: false };
  }

  // 无平台 ID，尝试豆瓣搜索补充海报
  const doubanCacheKey = `douban_${folderName}`;
  const doubanCached = !forceRefresh ? readCache(doubanCacheKey) : null;
  if (doubanCached) return { ...doubanCached, fromCache: true, localFiles: videoFiles, source: 'local' };

  let doubanInfo = {};
  try {
    const sr = await searchDouban(folderName);
    if (sr) {
      doubanInfo = {
        poster: sr.cover || '',
        score: sr.rating || '',
        doubanScore: sr.rating || '',
        year: sr.abstract?.match(/(\d{4})/)?.[1] || '',
        description: sr.abstract || '',
        cast: [],
        directors: [],
      };
      // 尝试拿详情页的简介和演员
      if (sr.subjectId) {
        const detail = await fetchDoubanDetail(sr.subjectId);
        if (detail) {
          if (detail.description) doubanInfo.description = detail.description;
          if (detail.directors.length) doubanInfo.directors = detail.directors;
          if (detail.cast.length) doubanInfo.cast = detail.cast;
        }
      }
    }
  } catch {}

  const result = {
    title: folderName,
    poster: doubanInfo.poster || '',
    year: doubanInfo.year || '',
    episodeAll: videoFiles.length,
    genres: [],
    description: doubanInfo.description || '',
    cast: doubanInfo.cast || [],
    directors: doubanInfo.directors || [],
    score: doubanInfo.score || '',
    doubanScore: doubanInfo.doubanScore || '',
    episodes: [],
    localFiles: videoFiles,
    source: 'local',
  };
  if (doubanInfo.poster) writeCache(doubanCacheKey, result);
  return { ...result, fromCache: false };
}

async function getVidPageTitle(vid) {
  try {
    const res = await axios.get(`https://v.qq.com/x/page/${vid}.html`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 10000,
    });
    const m = res.data.match(/<title>([^<]+)<\/title>/);
    if (m) return m[1].replace(/[_-].*$/, '').replace('_高清完整版视频在线观看_腾讯视频', '').trim();
  } catch {}
  return '';
}

// 豆瓣请求节流：至少间隔 2 秒
let lastDoubanRequest = 0;
async function doubanThrottle() {
  const now = Date.now();
  const wait = Math.max(0, 2200 - (now - lastDoubanRequest));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastDoubanRequest = Date.now();
}

async function searchDouban(query) {
  try {
    await doubanThrottle();
    const res = await axios.get(
      `https://movie.douban.com/subject_search?search_text=${encodeURIComponent(query)}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        timeout: 10000,
      }
    );
    const match = res.data.match(/window\.__DATA__\s*=\s*({.*?});/);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    if (data.total === 0 && data.error_info) return null; // 限流
    const items = data.items || [];
    // 优先匹配完全一致
    const exact = items.find(item => (item.title || '').includes(query));
    const item = exact || items[0];
    if (!item) return null;
    return {
      rating: String(item.rating?.value || ''),
      ratingCount: item.rating?.count || 0,
      url: item.url || '',
      subjectId: String(item.id || ''),
      abstract: item.abstract || '',
      cover: item.cover_url || '',
    };
  } catch {
    return null;
  }
}

/**
 * 从豆瓣移动端页面提取简介和演员信息
 */
async function fetchDoubanDetail(subjectId) {
  try {
    const res = await axios.get(`https://m.douban.com/movie/subject/${subjectId}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
      timeout: 10000,
    });
    const html = res.data;
    // meta description: "创可贴豆瓣评分：7.3 简介：..."
    const descM = html.match(/<meta name="description" content="([^"]+)"/);
    let description = '';
    if (descM) {
      const parts = descM[1].split('简介：');
      if (parts.length > 1) description = parts[1].trim();
    }
    // Extract director and cast from movie abstract (the one containing 执导)
    const absM = html.match(/<p class="abstract[^"]*"[^>]*>([^<]*执导[^<]*)<\/p>/);
    let directors = [];
    let cast = [];
    if (absM) {
      const text = absM[1];
      const dirM = text.match(/由(.+?)执导/);
      if (dirM) directors = dirM[1].split('、').map(n => ({ name: n.trim() }));
      const castM = text.match(/执导[，,\s]*([^等]+?)等?主演/);
      if (castM) cast = castM[1].split('、').map(n => ({ name: n.trim(), role: '' }));
    }
    return { description, directors, cast };
  } catch {
    return null;
  }
}

// GET /api/library/scan — 扫描所有剧文件夹摘要
router.get('/library/scan', async (req, res) => {
  try {
    const items = [];

    for (const base of FOLDERS_BASES) {
      const allFolders = scanFolders(base);
      for (const f of allFolders) {
        if (!hasDirectVideoFiles(f.path)) continue;

        // movie 文件夹特殊处理：每个文件单独当一部电影
        if (f.name === 'movie') {
          try {
            const entries = fs.readdirSync(f.path, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isFile() || e.name.startsWith('.') || !isVideoExt(e.name)) continue;
              let cacheKey = null;
              let summary = null;
              const vids = detectVidsFromName(e.name);
              if (vids.length) cacheKey = 'tx_' + vids[0];
              else { const tvid = detectIqiyiTvidFromName(e.name); if (tvid) cacheKey = 'iqiyi_' + tvid; }
              if (cacheKey) summary = readCache(cacheKey);

              items.push({
                folderName: e.name.replace(/\.[^.]+$/, ''),
                folderPath: f.path,
                videoFile: e.name,
                title: summary?.title || e.name.replace(/\.[^.]+$/, ''),
                poster: summary?.poster || summary?.verticalPoster || '',
                year: summary?.year || '',
                score: summary?.doubanScore || summary?.score || '',
                episodeAll: summary?.episodeAll || 1,
                source: summary?.source || '',
                hasCache: !!summary,
                genres: summary?.genres || [],
              });
            }
          } catch {}
          continue;
        }

        // 尝试读缓存（腾讯/爱奇艺/B站）
        let cacheKey = null;
        let summary = null;
        try {
          const entries = fs.readdirSync(f.path, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile() || e.name.startsWith('.') || !isVideoExt(e.name)) continue;
            const vids = detectVidsFromName(e.name);
            if (vids.length) { cacheKey = 'tx_' + vids[0]; break; }
            const tvid = detectIqiyiTvidFromName(e.name);
            if (tvid) { cacheKey = 'iqiyi_' + tvid; break; }
            const bvm = e.name.match(/BV[0-9A-Za-z]+/i);
            if (bvm) { cacheKey = 'bili_' + bvm[0]; break; }
            const epm = e.name.match(/ep(\d{4,})/i);
            if (epm) { cacheKey = 'bili_' + epm[1]; break; }
          }
        } catch {}
        if (cacheKey) summary = readCache(cacheKey);
        if (!summary && cacheKey && cacheKey.startsWith('bili_')) summary = readCache(`bili_${f.name}`);
        // 无平台缓存时，尝试豆瓣搜索缓存
        if (!summary) summary = readCache(`douban_${f.name}`);

        const fileCount = (() => {
          try {
            return fs.readdirSync(f.path).filter(n => isVideoExt(n) && !n.startsWith('.')).length;
          } catch { return 0; }
        })();

        items.push({
          folderName: f.name,
          folderPath: f.path,
          title: summary?.title || f.name,
          poster: summary?.poster || summary?.verticalPoster || '',
          year: summary?.year || '',
          score: summary?.doubanScore || summary?.score || '',
          episodeAll: summary?.episodeAll || fileCount,
          source: summary?.source || '',
          hasCache: !!summary,
          genres: summary?.genres || [],
        });
      }
    }

    res.json(success(items));
  } catch (err) {
    logger.error('[library_info] scan error:', err);
    res.status(500).json(fail(500, '扫描失败'));
  }
});

// GET /api/library/info — 单剧完整信息
router.get('/library/info', async (req, res) => {
  try {
    const folderPath = req.query.folder;
    if (!folderPath) return res.status(400).json(fail(400, '缺少 folder 参数'));
    const videoFile = req.query.file || '';

    const safePath = resolveLibraryDirectory(folderPath);
    const folderName = path.basename(safePath);
    const forceRefresh = req.query.refresh === '1';

    // movie 文件夹：单文件即一部电影，只查该文件
    if (folderName === 'movie' && videoFile) {
      const filePath = path.join(safePath, videoFile);
      if (!fs.existsSync(filePath)) return res.status(404).json(fail(404, '文件不存在'));

      // 尝试腾讯（movie 只传 vid 不传 cid，避免拿到合集页数据）
      const vids = detectVidsFromName(videoFile);
      if (vids.length) {
        const cacheKey = `tx_${vids[0]}`;
        const cached = !forceRefresh ? readCache(cacheKey) : null;
        if (cached) return res.json(success({ ...cached, fromCache: true, localFiles: [videoFile] }));
        const detail = await fetchTencentVideoDetail('', vids[0]);
        if (detail) {
            // 如果详情标题与文件名不匹配（合集场景），用 vid 页面标题
            const fileTitle = videoFile.replace(/\.[^.]+$/, '').replace(/第\d+集/, '').replace(/[_\s-]?\w{10,12}$/, '').trim();
            if (!detail.title || !fileTitle.includes(detail.title.replace(/[（(].*$/, '').trim()) && !detail.title.includes(fileTitle.slice(0,4))) {
              try {
                const pageTitle = await getVidPageTitle(vids[0]);
                if (pageTitle) detail.title = pageTitle;
              } catch {}
            }
            // 豆瓣搜索优先用文件名（更可靠），腾讯标题作 fallback
            const doubanQuery = fileTitle.replace(/[_\-\s]*[a-z]*\d{4,}[a-z]*$/i, '').replace(/[_\-\s]+$/, '').trim() || detail.title;
            try {
              const sr = (await searchDouban(doubanQuery)) || (doubanQuery !== detail.title ? await searchDouban(detail.title) : null);
              if (sr) {
                detail.doubanScore = sr.rating || detail.doubanScore;
                if (sr.cover) detail.poster = sr.cover;
                if (sr.abstract && !detail.description) detail.description = sr.abstract;
                if (sr.subjectId) {
                  const dd = await fetchDoubanDetail(sr.subjectId);
                  if (dd) {
                    if (dd.description && (!detail.description || dd.description.length > detail.description.length)) detail.description = dd.description;
                    if (dd.directors.length) detail.directors = dd.directors;
                    if (dd.cast.length) detail.cast = dd.cast;
                  }
                }
              }
            } catch {}
            // 电影场景：只保留匹配的分集，强制 1 集
            detail.episodeAll = 1;
            if (detail.episodes && detail.episodes.length > 1) {
              detail.episodes = detail.episodes.filter(ep => ep.vid === vids[0]);
            }
            if (!detail.episodes || !detail.episodes.length) {
              detail.episodes = [{ title: detail.title, vid: vids[0] }];
            }
            const result = { ...detail, localFiles: [videoFile], source: 'tencent' };
            writeCache(cacheKey, result);
            return res.json(success({ ...result, fromCache: false }));
          }
      }

      // 简单返回
      return res.json(success({
        title: videoFile.replace(/\.[^.]+$/, ''), localFiles: [videoFile],
        source: 'local', episodeAll: 1, episodes: [], cast: [], directors: [],
        genres: [], poster: '', year: '', score: '', doubanScore: '', description: '',
      }));
    }

    if (!forceRefresh) {
      // 尝试从缓存恢复
      try {
        const entries = fs.readdirSync(safePath, { withFileTypes: true });
        const allVideoFiles = entries.filter(e => e.isFile() && !e.name.startsWith('.') && isVideoExt(e.name)).map(e => e.name);
        for (const e of entries) {
          if (!e.isFile() || e.name.startsWith('.') || !isVideoExt(e.name)) continue;
          const vids = detectVidsFromName(e.name);
          if (vids.length) {
            const cached = readCache(`tx_${vids[0]}`);
            if (cached) return res.json(success({ ...cached, fromCache: true, localFiles: allVideoFiles }));
          }
          const tvid = detectIqiyiTvidFromName(e.name);
          if (tvid) {
            const cached = readCache(`iqiyi_${tvid}`);
            if (cached) return res.json(success({ ...cached, fromCache: true, localFiles: allVideoFiles }));
          }
          const bvm = e.name.match(/BV[0-9A-Za-z]+/i);
          if (bvm) {
            const cached = readCache(`bili_${bvm[0]}`);
            if (cached) return res.json(success({ ...cached, fromCache: true, localFiles: allVideoFiles }));
          }
        }
      } catch {}
    }

    const info = await detectAndFetch(safePath, folderName, forceRefresh);
    if (!info) return res.status(404).json(fail(404, '无法获取信息'));
    res.json(success(info));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error('[library_info] info error:', err);
    res.status(status).json(fail(status, err.message || '获取失败'));
  }
});

// GET /api/library/poster — 图片代理，绕过防盗链
router.get('/library/poster', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('missing url');
    const allowedHosts = ['doubanio.com', 'iqiyipic.com', 'qpic.cn', 'hdslb.com'];
    const host = new URL(url).hostname;
    if (!allowedHosts.some(h => host.endsWith(h))) return res.status(403).send('blocked host');

    const referer = host.includes('hdslb.com') ? 'https://www.bilibili.com/'
      : host.includes('iqiyipic.com') ? 'https://www.iqiyi.com/'
      : 'https://movie.douban.com/';
    const img = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    res.set('Content-Type', img.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(img.data));
  } catch (err) {
    res.status(500).send('proxy error');
  }
});

// POST /api/library/play — 用 IINA 播放指定剧集
router.post('/library/play', (req, res) => {
  try {
    const { folderPath, episode, videoFile } = req.body || {};
    if (!folderPath) return res.status(400).json(fail(400, '缺少参数'));
    const safePath = resolveLibraryDirectory(folderPath);

    // 扫描视频文件
    const files = fs.readdirSync(safePath, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.') && isVideoExt(e.name))
      .map(e => e.name);

    // 指定文件直接播（movie 场景）
    if (videoFile && files.includes(videoFile)) {
      const fullPath = path.join(safePath, videoFile);
      require('child_process').exec(`open -a IINA "${fullPath}"`, (err) => {
        if (err) return res.status(500).json(fail(500, '启动 IINA 失败: ' + err.message));
        res.json(success({ file: videoFile }));
      });
      return;
    }

    if (!episode) return res.status(400).json(fail(400, '缺少 episode 或 videoFile 参数'));

    let targetFile = null;
    const epNum = Number(episode);

    for (const f of files) {
      // 优先匹配 S01E03 格式的集号
      let fileNum = null;
      const em = f.match(/E(\d{2,3})/i);
      if (em) fileNum = parseInt(em[1], 10);
      // 否则匹配纯数字文件名或 _数字_ 格式
      if (!fileNum) {
        const pm = f.match(/(?:^|[_\s])(\d{1,2})(?=[_\s]|$|\.)/);
        if (pm) fileNum = parseInt(pm[1], 10);
      }
      if (!fileNum) continue;

      // 精确匹配：文件编号等于集号
      if (fileNum === epNum) { targetFile = f; break; }

      // 双集合并：一集文件对应两集腾讯（如 01.mp4 → ep 1+2, 02.mp4 → ep 3+4）
      if (!targetFile) {
        const startEp = (fileNum - 1) * 2 + 1;
        const endEp = startEp + 1;
        if (epNum >= startEp && epNum <= endEp) targetFile = f;
      }
    }

    if (!targetFile) {
      // 无集号匹配时，用 episode 作为文件序号（B站等）
      const sorted = files.sort();
      const idx = epNum - 1;
      if (idx >= 0 && idx < sorted.length) {
        targetFile = sorted[idx];
      }
    }

    if (!targetFile) {
      return res.status(404).json(fail(404, `未找到第${epNum}集对应的视频文件`));
    }

    const fullPath = path.join(safePath, targetFile);
    require('child_process').exec(`open -a IINA "${fullPath}"`, (err) => {
      if (err) {
        logger.error('[library_info] IINA 启动失败:', err.message);
        return res.status(500).json(fail(500, '启动 IINA 失败: ' + err.message));
      }
      res.json(success({ file: targetFile, episode: epNum }));
    });
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    res.status(status).json(fail(status, err.message || '播放失败'));
  }
});

module.exports = router;
