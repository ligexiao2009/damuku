#!/usr/bin/env node
/**
 * 流嗅探 - 抓取 m3u8/直播流地址
 * 用法: node scripts/stream-sniffer.js
 */

const CDP = 'http://127.0.0.1:9222';
const found = new Set();

async function fetchJSON(u) { return (await fetch(u)).json(); }

function handleMessage(msg) {
  if (msg.method !== 'Network.requestWillBeSent') return;
  let u = msg.params.request.url;

  let urls = [u];
  try {
    const d = decodeURIComponent(u);
    let idx = 0;
    while ((idx = d.indexOf('.m3u8', idx)) > -1) {
      let start = Math.max(d.lastIndexOf('https://', idx), d.lastIndexOf('http://', idx));
      if (start < 0) { idx += 5; continue; }
      let end = d.indexOf('https://', start + 10);
      if (end < 0) end = d.indexOf('http://', start + 10);
      if (end < 0) end = d.length;
      urls.push(d.slice(start, end));
      idx = end;
    }
  } catch {}

  for (const cu of urls) {
    if (/\.m3u8|\.mpd|flv\?/.test(cu) && !found.has(cu)) {
      found.add(cu);
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      console.log(`\x1b[32m[${ts}]\x1b[0m ${cu}`);
      if (process.argv[2]) {
        const copyCmd = process.platform === 'darwin' ? 'pbcopy' : (process.platform === 'linux' ? 'xclip -selection clipboard' : 'clip');
      require('child_process').exec(`echo "${cu.replace(/"/g,'\\"')}" | ${copyCmd}`);        console.log('已复制到剪贴板');
        setTimeout(() => process.exit(0), 500);
      }
    }
  }
}

const allSockets = [];
function connectToTab(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  allSockets.push(ws);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    // 监听 iframe / 新 target
    ws.send(JSON.stringify({ id: 2, method: 'Target.setDiscoverTargets', params: { discover: true } }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
    // 发现新 target（iframe 等），自动连接
    if (msg.method === 'Target.targetCreated') {
      const info = msg.params.targetInfo;
      if (info.type === 'iframe' || (info.type === 'page' && info.url !== 'about:blank')) {
        connectTarget(info.targetId);
      }
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {};
  return ws;
}

// 通过 browser-level WS 连接 target
async function connectTarget(targetId) {
  try {
    const tabs = await fetchJSON(`${CDP}/json`);
    const t = tabs.find(t => t.id === targetId);
    if (!t || !t.webSocketDebuggerUrl) return;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    allSockets.push(ws);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    };
    ws.onerror = () => {};
    ws.onclose = () => {};
  } catch {}
}

async function main() {
  // 尝试连接，失败则启动 Chrome
  let version;
  try { version = await fetchJSON(`${CDP}/json/version`); }
  catch {
    console.log('启动 Chrome 调试模式...');
    const { spawn } = require('child_process');
    const chromePath = process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'linux'
        ? (require('fs').existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome'
          : require('fs').existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable'
          : require('fs').existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome')
        : 'google-chrome';
    spawn(chromePath, [
      '--remote-debugging-port=9222', '--user-data-dir=/tmp/chrome-debug', '--no-first-run', '--no-sandbox', 'about:blank',
    ], { detached: true, stdio: 'ignore' }).unref();
    await new Promise(r => setTimeout(r, 3000));
    for (let i = 0; i < 10; i++) {
      try { version = await fetchJSON(`${CDP}/json/version`); break; }
      catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!version) { console.error('Chrome 启动失败'); process.exit(1); }
  }
  const targetUrl = process.argv[2];
  if (targetUrl) console.log(`目标: ${targetUrl}`);
  console.log('Chrome 已就绪\n');

  const sockets = new Map(); // pageId → ws
  const seen = new Set();

  // 自动导航
  if (targetUrl) {
    let tab = (await fetchJSON(`${CDP}/json`)).find(t => t.type === 'page');
    if (tab) {
      const pws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise(r => { pws.onopen = () => { pws.send(JSON.stringify({ id:1,method:'Page.enable' })); r(); } });
      pws.send(JSON.stringify({ id:2,method:'Page.navigate',params:{url:targetUrl} }));
      await new Promise(r => setTimeout(r, 2000));
      pws.close();
    }
  }

  // 定时扫描新页面
  while (true) {
    try {
      const tabs = await fetchJSON(`${CDP}/json`);
      const pages = tabs.filter(t => t.type === 'page' && t.url !== 'about:blank');
      for (const p of pages) {
        if (!sockets.has(p.id)) {
          if (seen.has(p.id)) {
            // 页面已刷新，重连
            sockets.get(p.id)?.close();
            sockets.delete(p.id);
            seen.delete(p.id);
          }
          seen.add(p.id);
          sockets.set(p.id, connectToTab(p));
          console.log(`已连接: ${p.title || p.url}`);
        }
      }
      // 清理关闭的页面
      const activeIds = new Set(pages.map(p => p.id));
      for (const [id, sock] of sockets) {
        if (!activeIds.has(id)) { sock.close(); sockets.delete(id); }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
}

process.on('SIGINT', () => {
  allSockets.forEach(s => { try { s.close() } catch {} });
  console.log(`\n共捕获 ${found.size} 条流地址`);
  [...found].forEach(u => console.log(u));
  if (found.size) {
    const copyCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
    require('child_process').exec(`echo "${[...found][0]}" | ${copyCmd}`);
  }
  process.exit(0);
});

main().catch(e => { console.error(e.message); process.exit(1); });
