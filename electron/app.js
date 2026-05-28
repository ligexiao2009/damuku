/**
 * app.js — Packaged app entry point.
 * Starts the Express server, then launches the Electron overlay windows.
 */

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// --- Config: use user-writable directories for packaged app ---
const isPackaged = app.isPackaged;
const userDataDir = app.getPath('userData');

// Load .env from user data dir (writable), fall back to app dir (dev mode)
const envPath = isPackaged
  ? path.join(userDataDir, '.env')
  : path.join(__dirname, '..', '.env');

// In packaged mode, try to migrate from existing .env files on first run
if (isPackaged) {
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const candidatePaths = [
      path.join(app.getPath('home'), '.danmu.env'),
      path.join(app.getPath('home'), 'video', '.env'),
      path.join(path.dirname(app.getPath('exe')), '.env'),
    ];
    let migrated = false;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          fs.copyFileSync(p, envPath);
          console.log('[app] Migrated .env from:', p);
          migrated = true;
          break;
        } catch (e) {
          console.log('[app] Failed to migrate from:', p, e.message);
        }
      }
    }
    if (!migrated) {
      const template = `# B站弹幕外挂配置文件
# 视频文件目录（必填，多个路径用逗号分隔）
FOLDERS_BASE=/Users/${os.userInfo().username}/video
# 服务端口
PORT=5001
# B站 SESSDATA（可选，登录后抓取，用于获取高清弹幕）
# BILI_SESSDATA=your_sessdata_here
`;
      fs.writeFileSync(envPath, template, 'utf-8');
      console.log('[app] Created template .env at:', envPath);
    }
  }
}

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('[app] Loaded env from:', envPath);
}

// Auto-migrate old VIDEO_DIR to FOLDERS_BASE if needed
if (isPackaged && process.env.VIDEO_DIR && !process.env.FOLDERS_BASE) {
  process.env.FOLDERS_BASE = process.env.VIDEO_DIR;
  console.log('[app] Auto-migrated VIDEO_DIR → FOLDERS_BASE:', process.env.FOLDERS_BASE);
}

console.log('[app] FOLDERS_BASE =', process.env.FOLDERS_BASE || '(not set)');

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('[app] Loaded env from:', envPath);
}

// Override cache/playback directories to writable location
process.env.CACHE_BASE = path.join(userDataDir, 'data');
const cacheBase = process.env.CACHE_BASE;
for (const dir of ['cache', 'playback', 'cache/danmu', 'cache/thumbs', 'cache/meta']) {
  const p = path.join(userDataDir, 'data', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const PORT = process.env.PORT || 3000;
const serverUrl = `http://localhost:${PORT}`;

// --- Kill any existing process on PORT ---
function killPortIfOccupied(port) {
  try {
    const pid = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim();
    if (pid) {
      console.log(`[app] Port ${port} is occupied by PID ${pid}, killing...`);
      execSync(`kill -9 ${pid}`);
      console.log(`[app] Killed PID ${pid}, port ${port} released`);
    }
  } catch {
    // lsof returns non-zero when no process is found — that means port is free
    console.log(`[app] Port ${port} is free`);
  }
}

killPortIfOccupied(PORT);

// --- Start the Express server ---
let serverStarted = false;
try {
  // monkey-patch path resolution so server.js uses writable dirs
  const origJoin = path.join;
  const serverDir = isPackaged ? userDataDir : path.join(__dirname, '..');

  require('../server.js');
  serverStarted = true;
  console.log(`[app] Server listening on ${serverUrl}`);
} catch (e) {
  console.error('[app] Failed to start server:', e.message, e.stack);
}

// --- Overlay windows ---

let overlayWindows = [];

function createOverlayWindow(display) {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x, y, width,height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, '../public/Danmu.iconset') // 路径根据你放置的位置调整
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`${serverUrl}/overlay.html`);
  win.setTitle('Danmaku Overlay');

  win.once('ready-to-show', () => {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[overlay] Page load failed: ${errorCode} - ${errorDescription}`);
  });

  win.on('closed', () => {
    overlayWindows = overlayWindows.filter(w => w !== win);
  });

  return win;
}

function createAllWindows() {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  console.log(`[overlay] Creating windows for ${displays.length} display(s)`);
  for (const display of displays) {
    overlayWindows.push(createOverlayWindow(display));
  }
}

function closeAllWindows() {
  for (const win of [...overlayWindows]) win.close();
}

// --- Global Shortcuts ---

function registerShortcuts() {
  const shortcuts = {
    'CmdOrCtrl+Space':       'shortcut:play-pause',
    'CmdOrCtrl+Left':        'shortcut:seek-backward',
    'CmdOrCtrl+Right':       'shortcut:seek-forward',
    'CmdOrCtrl+Shift+Left':  'shortcut:seek-backward-big',
    'CmdOrCtrl+Shift+Right': 'shortcut:seek-forward-big',
    'CmdOrCtrl+Up':          'shortcut:opacity-up',
    'CmdOrCtrl+Down':        'shortcut:opacity-down',
    'CmdOrCtrl+Shift+Up':    'shortcut:fontsize-up',
    'CmdOrCtrl+Shift+Down':  'shortcut:fontsize-down',
    'CmdOrCtrl+O':           'shortcut:toggle-panel',
    'CmdOrCtrl+L':           'shortcut:load-danmaku'
  };

  for (const [key, channel] of Object.entries(shortcuts)) {
    try {
      globalShortcut.register(key, () => {
        for (const win of overlayWindows) {
          win.webContents.send(channel);
        }
      });
    } catch (e) { /* some shortcuts may fail on macOS */ }
  }

  try { globalShortcut.register('CmdOrCtrl+Q', () => app.quit()); } catch {}
}

// --- IPC ---

ipcMain.on('set-click-through', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setIgnoreMouseEvents(enabled, { forward: true });
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// --- Lifecycle ---

app.whenReady().then(() => {
  // 【关键修改点】为了能在 macOS 全屏视频上显示覆盖层，必须隐藏 Dock 图标
  if (app.dock) app.dock.hide();

  setTimeout(() => {
    createAllWindows();
    registerShortcuts();
  }, serverStarted ? 300 : 2000); // wait longer if server just started

  const { screen } = require('electron');
  screen.on('display-added', (_event, display) => {
    overlayWindows.push(createOverlayWindow(display));
  });
  screen.on('display-removed', (_event, display) => {
    for (const win of overlayWindows) {
      const b = win.getBounds();
      if (b.x === display.bounds.x && b.y === display.bounds.y) {
        win.close();
        break;
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAllWindows();
  });
});

app.on('window-all-closed', () => { globalShortcut.unregisterAll(); app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); closeAllWindows(); });