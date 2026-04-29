/**
 * preload.js — secure bridge between Electron main process and overlay renderer.
 * Uses contextBridge to safely expose IPC channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Listen for shortcut commands from main process
  onShortcut: (channel, callback) => {
    const validChannels = [
      'play-pause', 'seek-forward', 'seek-backward',
      'seek-forward-big', 'seek-backward-big',
      'opacity-up', 'opacity-down',
      'fontsize-up', 'fontsize-down',
      'toggle-panel', 'load-danmaku'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(`shortcut:${channel}`, (_event, ...args) => callback(...args));
    }
  },

  // Request mouse events to pass through (click-through mode)
  setClickThrough: (enabled) => {
    ipcRenderer.send('set-click-through', enabled);
  },

  // Close the window
  closeWindow: () => {
    ipcRenderer.send('close-window');
  }
});
