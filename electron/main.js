/**
 * main.js — Electron main process for the danmaku overlay.
 *
 * Creates a transparent, frameless, always-on-top, fullscreen window
 * that sits on top of any video player and displays Bilibili danmaku.
 */

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Read PORT from .env if available, otherwise default to 3000
let defaultPort = 3000;
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
  const portMatch = envFile.match(/PORT\s*=\s*(\d+)/);
  if (portMatch) defaultPort = parseInt(portMatch[1], 10);
} catch {}
const SERVER_URL = process.env.OVERLAY_SERVER || `http://localhost:${defaultPort}`;

let overlayWindows = [];

function createOverlayWindow(display) {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x, y, width, height,
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
    }
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`${SERVER_URL}/overlay.html`);
  win.setTitle('Danmaku Overlay');

  win.once('ready-to-show', () => {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[overlay] Page load failed on display ${display.id}: ${errorCode} - ${errorDescription}`);
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
    const win = createOverlayWindow(display);
    overlayWindows.push(win);
    console.log(`[overlay] Display ${display.id}: ${display.bounds.width}x${display.bounds.height} at (${display.bounds.x}, ${display.bounds.y})`);
  }
}

function closeAllWindows() {
  for (const win of [...overlayWindows]) {
    win.close();
  }
  overlayWindows = [];
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
      console.log(`[shortcut] ${key} registered`);
    } catch (e) {
      console.log(`[shortcut] ${key} failed: ${e.message}`);
    }
  }

  // Quit
  try {
    globalShortcut.register('CmdOrCtrl+Q', () => app.quit());
    console.log('[shortcut] CmdOrCtrl+Q registered');
  } catch {}

  console.log('[shortcuts] Registration complete');
}

// --- IPC Handlers ---

ipcMain.on('set-click-through', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setIgnoreMouseEvents(enabled, { forward: true });
  }
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  createAllWindows();
  registerShortcuts();

  // Handle display changes (plug/unplug monitors)
  const { screen } = require('electron');
  screen.on('display-added', (_event, display) => {
    console.log(`[overlay] New display detected: ${display.id}`);
    const win = createOverlayWindow(display);
    overlayWindows.push(win);
  });

  screen.on('display-removed', (_event, display) => {
    console.log(`[overlay] Display removed: ${display.id}`);
    // Find and close the window covering this display
    for (const win of overlayWindows) {
      const bounds = win.getBounds();
      if (bounds.x === display.bounds.x && bounds.y === display.bounds.y) {
        win.close();
        break;
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAllWindows();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  closeAllWindows();
});
