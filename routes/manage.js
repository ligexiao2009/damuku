const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { success, fail } = require('../utils/response');
const { isPathInside, resolvePathInside, isVideoExt } = require('../utils/file');
const logger = require('../utils/logger');
const { FOLDERS_BASE, RETENTION_CONFIG_FILE } = require('../shared/constants');
const {
  resolveLibraryDirectory,
  resolveLibraryVideoFile,
  isPathValidationError,
  scanVideoFiles
} = require('../shared/helpers');

const router = require('express').Router();

// GET /api/manage/videos
router.get('/manage/videos', (req, res) => {
  try {
    const folder = req.query.folder;
    let files;
    if (folder) {
      const resolved = resolveLibraryDirectory(folder);
      files = [];
      let entries;
      try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isFile() || !isVideoExt(entry.name)) continue;
        const fp = path.join(resolved, entry.name);
        const stat = fs.statSync(fp);
        files.push({ name: entry.name, path: fp, size: stat.size, mtime: stat.mtimeMs, folder: path.relative(FOLDERS_BASE, resolved) || '' });
      }
    } else {
      files = scanVideoFiles(FOLDERS_BASE).map(f => {
        const stat = fs.statSync(f.path);
        return { name: f.name.split(path.sep).pop(), path: f.path, size: stat.size, mtime: stat.mtimeMs, folder: path.relative(FOLDERS_BASE, path.dirname(f.path)) || '' };
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    res.json(success(files));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, status === 400 ? err.message : '读取视频列表失败'));
  }
});

// DELETE /api/manage/video
router.delete('/manage/video', (req, res) => {
  try {
    const filePath = req.body.path;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json(fail(400, '缺少 path 参数'));
    }
    const resolved = resolveLibraryVideoFile(filePath);
    fs.unlinkSync(resolved);
    logger.info(`🗑️  [manage] 删除视频: ${resolved}`);
    res.json(success(null, '删除成功'));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, err.message));
  }
});

// GET /api/manage/retention
router.get('/manage/retention', (_req, res) => {
  try {
    if (!fs.existsSync(RETENTION_CONFIG_FILE)) return res.json(success({ folders: {} }));
    res.json(success(JSON.parse(fs.readFileSync(RETENTION_CONFIG_FILE, 'utf-8'))));
  } catch {
    res.json(success({ folders: {} }));
  }
});

// PUT /api/manage/retention
router.put('/manage/retention', (req, res) => {
  try {
    const { type, folder, file: filePath, path: filePathAlt, days } = req.body || {};
    const targetPath = folder || filePath || filePathAlt;
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json(fail(400, '缺少 folder/path 参数'));
    }
    if (typeof days !== 'number' || days < 0 || !Number.isInteger(days)) {
      return res.status(400).json(fail(400, 'days 必须是非负整数'));
    }
    const isFile = type === 'file' || (filePath || filePathAlt);
    const resolved = days === 0
      ? resolvePathInside(targetPath, FOLDERS_BASE)
      : (isFile ? resolveLibraryVideoFile(targetPath) : resolveLibraryDirectory(targetPath));
    let config = { folders: {}, files: {} };
    if (fs.existsSync(RETENTION_CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(RETENTION_CONFIG_FILE, 'utf-8'));
    }

    if (isFile) {
      if (!config.files) config.files = {};
      if (days === 0) delete config.files[resolved];
      else config.files[resolved] = { days, setAt: Date.now() };
    } else {
      if (!config.folders) config.folders = {};
      if (days === 0) delete config.folders[resolved];
      else config.folders[resolved] = { days, setAt: Date.now() };
    }

    fs.writeFileSync(RETENTION_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json(success(config));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    res.status(status).json(fail(status, err.message));
  }
});

// POST /api/manage/play — IINA 播放本地文件
router.post('/manage/play', (req, res) => {
  try {
    const { filePath } = req.body || {};
    if (!filePath) return res.status(400).json(fail(400, '缺少文件路径'));
    const resolved = resolvePathInside(filePath, FOLDERS_BASE);
    if (!fs.existsSync(resolved)) return res.status(404).json(fail(404, '文件不存在'));
    require('child_process').exec(`open -a IINA "${resolved}"`, (err) => {
      if (err) return res.status(500).json(fail(500, '启动 IINA 失败'));
      res.json(success({ file: path.basename(resolved) }));
    });
  } catch (err) {
    res.status(400).json(fail(400, err.message));
  }
});

// POST /api/stream/play — IINA 播放直播流 URL
router.post('/stream/play', (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json(fail(400, '缺少流地址'));
    if (!/^https?:\/\//.test(url)) return res.status(400).json(fail(400, '无效的 URL'));
    require('child_process').exec(`open -a IINA "${url.replace(/"/g, '\\"')}"`, (err) => {
      if (err) return res.status(500).json(fail(500, '启动 IINA 失败'));
      res.json(success({}));
    });
  } catch (err) {
    res.status(400).json(fail(400, err.message));
  }
});

// POST /api/stream/sniff — 从网页地址提取流地址
router.post('/stream/sniff', async (req, res) => {
  try {
    const { pageUrl } = req.body || {};
    if (!pageUrl) return res.status(400).json(fail(400, '缺少网页地址'));

    // 先尝试直接模式：已知站点的 ID 提取
    const known = [
      { regex: /play\.sportsteam\d+\.com\/play\/[jk]\.php\?id=(\d+)/, url: (id) => `http://hls.sportsteam356.com/live/${id}.m3u8` },
      { regex: /play\.sportsteam\d+\.com\/play\/[jk]bs?\.html\?id=100(\d+)/, url: (id) => `http://hls.sportsteam356.com/live/${id}.m3u8` },
    ];

    for (const k of known) {
      const m = pageUrl.match(k.regex);
      if (m) {
        const streamUrl = k.url(m[1]);
        try {
          const test = await axios.head(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
          if (test.status === 200) return res.json(success({ streamUrl, method: 'direct' }));
        } catch {}
      }
    }

    // 直接模式失败，后台启动 sniffer 脚本
    const { spawn } = require('child_process');
    const uid = Date.now().toString(36);
    const outFile = path.join(require('os').tmpdir(), `stream_sniff_${uid}.txt`);
    const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'stream-sniffer.js'), pageUrl], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.unref();

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {});

    // 等待结果（最多 60 秒）
    const streamUrl = await new Promise((resolve) => {
      const check = setInterval(() => {
        const lines = output.split('\n');
        for (const line of lines) {
          const m = line.match(/https?:\/\/[^\s\x1b]+?\.m3u8[^\s\x1b]*/);
          if (m) { clearInterval(check); resolve(m[0]); }
        }
      }, 1000);
      setTimeout(() => { clearInterval(check); resolve(''); }, 60000);
    });

    if (streamUrl) {
      return res.json(success({ streamUrl, method: 'cdp' }));
    }
    return res.status(404).json(fail(404, '未找到流地址，请在弹出的 Chrome 窗口点击播放'));
  } catch (err) {
    logger.error('[stream/sniff]', err.message);
    res.status(500).json(fail(500, err.message));
  }
});

// POST /api/stream/txsp — 从腾讯体育页面提取 roomId/programId/cookie
router.post('/stream/txsp', async (req, res) => {
  try {
    const { pageUrl } = req.body || {};
    const url = pageUrl || 'https://v.qq.com/live/p/newtopic/366948/index.html';

    // 启动 Chrome
    const CDP = 'http://127.0.0.1:9222';
    let wsReady = false;
    try { await axios.get(`${CDP}/json/version`, { timeout: 2000 }); wsReady = true; } catch {}
    if (!wsReady) {
      const { spawn } = require('child_process');
      spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--remote-debugging-port=9222', '--user-data-dir=/tmp/chrome-debug', '--no-first-run', 'about:blank',
      ], { detached: true, stdio: 'ignore' }).unref();
      await new Promise(r => setTimeout(r, 3000));
      for (let i = 0; i < 10; i++) {
        try { await axios.get(`${CDP}/json/version`, { timeout: 2000 }); wsReady = true; break; }
        catch { await new Promise(r => setTimeout(r, 1000)); }
      }
    }
    if (!wsReady) return res.status(500).json(fail(500, 'Chrome 未就绪'));

    let tabs = (await axios.get(`${CDP}/json`)).data;
    let tab = tabs.find(t => t.type === 'page') || tabs[0];
    if (!tab) {
      await axios.put(`${CDP}/json/new?url=about:blank`);
      await new Promise(r => setTimeout(r, 1000));
      tabs = (await axios.get(`${CDP}/json`)).data;
      tab = tabs.find(t => t.type === 'page') || tabs[0];
    }
    if (!tab) return res.status(500).json(fail(500, '无标签'));

    const WebSocket = globalThis.WebSocket;
    const ws = new WebSocket(tab.webSocketDebuggerUrl);

    const result = await new Promise((resolve) => {
      let pageReady = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
        ws.send(JSON.stringify({ id: 3, method: 'Network.enable' }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1 && !msg.error) {
          ws.send(JSON.stringify({ id: 10, method: 'Page.navigate', params: { url } }));
        }
        if (msg.method === 'Page.loadEventFired') {
          pageReady = true;
          // 等待 SPA 渲染完成后提取
          setTimeout(() => extractData(), 5000);
        }
        // 监听 XHR 响应（最可靠的方式）
        if (msg.method === 'Network.responseReceived') {
          const resp = msg.params.response;
          if (resp.url.includes('trpc.live_main_logic') || resp.url.includes('getProgram')) {
            // 拿到 XHR 的 requestId，请求 body
            ws.send(JSON.stringify({
              id: 30, method: 'Network.getResponseBody',
              params: { requestId: msg.params.requestId }
            }));
          }
        }
        // XHR response body
        if (msg.id === 30 && msg.result) {
          try {
            const body = msg.result.body;
            const data = JSON.parse(body);
            const s = JSON.stringify(data);
            const rm = s.match(/"room_?id"\s*[:=]\s*"?(\d+)/i) || s.match(/room_?id['"]?\s*[:=]\s*(\d+)/i);
            const pm = s.match(/"program_?id"\s*[:=]\s*"?(\d+)/i) || s.match(/program_?id['"]?\s*[:=]\s*['"]?(\d+)/i);
            if (rm || pm) {
              ws.send(JSON.stringify({
                id: 40, method: 'Runtime.evaluate',
                params: { expression: 'document.cookie', returnByValue: true }
              }));
              const resultData = { roomId: rm ? rm[1] : '', programId: pm ? pm[1] : '', cookie: '' };
              ws.onmessage = (ev2) => {
                const m2 = JSON.parse(ev2.data);
                if (m2.id === 40) {
                  resultData.cookie = m2.result?.result?.value || '';
                  ws.close();
                  resolve(resultData);
                }
              };
            }
          } catch {}
        }
        if (msg.id === 20) {
          try {
            const data = JSON.parse(msg.result?.result?.value || '{}');
            if (data.roomId || data.programId) { ws.close(); resolve(data); }
          } catch {}
        }
      };

      function extractData() {
        ws.send(JSON.stringify({
          id: 20, method: 'Runtime.evaluate',
          params: {
            expression: `(function(){
              var r='',p='';
              // __NUXT__ state
              if(window.__NUXT__){try{var s=JSON.stringify(window.__NUXT__);var rm=s.match(/"room_?id"\\\\s*[:=]\\\\s*"?(\\\\d+)/i)||s.match(/room_?id['"]?\\\\s*[:=]\\\\s*['"]?(\\\\d+)/i);if(rm)r=rm[1];var pm=s.match(/"program_?id"\\\\s*[:=]\\\\s*"?(\\\\d+)/i)||s.match(/program_?id['"]?\\\\s*[:=]\\\\s*['"]?(\\\\d+)/i);if(pm)p=pm[1]}catch(e){}}
              // URL 匹配: /live/p/newtopic/366948/index.html
              var um=location.href.match(/\\\\/live\\\\/p\\\\/\\\\w+\\\\/(\\\\d+)/);if(um&&!p)p=um[1];
              // 搜 script 内容
              var scripts=document.querySelectorAll('script');for(var i=0;i<scripts.length;i++){var t=scripts[i].textContent||'';var rm2=t.match(/"room_?id"\\\\s*[:=]\\\\s*"?(\\\\d+)/i);if(rm2&&!r)r=rm2[1];var pm2=t.match(/"program_?id"\\\\s*[:=]\\\\s*"?(\\\\d+)/i);if(pm2&&!p)p=pm2[1]}
              // window 全局变量
              try{var w=window.__INITIAL_STATE__||window.store;if(w){var s2=JSON.stringify(w);var rm3=s2.match(/\\\\"room_?id\\\\"\\\\s*:\\\\s*"?(\\\\d+)/i);if(rm3&&!r)r=rm3[1];var pm3=s2.match(/\\\\"program_?id\\\\"\\\\s*:\\\\s*"?(\\\\d+)/i);if(pm3&&!p)p=pm3[1]}}catch(e){}
              // 当前 cookies
              var ck=document.cookie;
              return JSON.stringify({roomId:r||'',programId:p||'',cookie:ck});
            })()`,
            returnByValue: true
          }
        }));
      }

      setTimeout(() => { ws.close(); resolve({}); }, 25000);
    });

    // URL 本身就是 programId: /live/p/newtopic/366948/index.html
    if (!result.programId) {
      const pm = url.match(/\/live\/p\/(?:\w+\/)?(\d{5,})/);
      if (pm) result.programId = pm[1];
    }

    if (result.roomId || result.programId) {
      return res.json(success(result));
    }
    res.json(success({ ...result, hint: '请确保页面已加载完成' }));
  } catch (err) {
    logger.error('[stream/txsp]', err.message);
    res.status(500).json(fail(500, err.message));
  }
});

module.exports = router;
