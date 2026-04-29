/**
 * overlay.js — logic for the transparent danmaku overlay page.
 * Works standalone in a browser (for testing) and inside Electron.
 */

(function () {
  const SERVER = `http://${location.hostname}:${location.port || 3000}`;

  // DOM
  const danmakuLayer = document.getElementById('danmaku-layer');
  const controlPanel = document.getElementById('control-panel');
  const bvidInput = document.getElementById('bvid-input');
  const loadBtn = document.getElementById('load-btn');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const offsetSlider = document.getElementById('offset-slider');
  const offsetVal = document.getElementById('offset-val');
  const fontSizeSlider = document.getElementById('fontsize-slider');
  const fontSizeVal = document.getElementById('fontsize-val');
  const opacitySlider = document.getElementById('opacity-slider');
  const opacityVal = document.getElementById('opacity-val');
  const speedSlider = document.getElementById('speed-slider');
  const speedVal = document.getElementById('speed-val');
  const areaSlider = document.getElementById('area-slider');
  const areaVal = document.getElementById('area-val');
  const resetBtn = document.getElementById('reset-btn');
  const exitBtn = document.getElementById('exit-btn');
  const statusText = document.getElementById('status-text');
  const statusIndicator = document.getElementById('status-indicator');
  const seekBar = document.getElementById('seek-bar');
  const seekTimeLabel = document.getElementById('seek-time');
  const timestampBtn = document.getElementById('timestamp-btn');

  let fadeTimer = null;

  // Engine
  const engine = new DanmakuEngine(danmakuLayer, {
    speed: 18,
    area: 25,
    offset: 0,
    fontSize: 32,
    opacity: 1
  });

  // State
  let isRunning = false;
  let simTime = 0;
  let simStartPerf = 0;
  let panelVisible = false;
  let currentBvid = '';
  let maxDuration = 10800; // 3 hours, updated from server config
  let isSeeking = false;   // pause time updates while user drags

  // --- Load saved config from server ---
  async function loadConfig() {
    try {
      const res = await fetch(`${SERVER}/api/overlay-config`);
      const cfg = await res.json();
      if (cfg.maxDuration) {
        maxDuration = cfg.maxDuration;
        seekBar.max = maxDuration;
      }
      engine.configure(cfg);
      syncControlsFromEngine();
    } catch (e) {
      console.log('无法加载配置，使用默认值');
    }
  }

  async function saveConfig() {
    try {
      await fetch(`${SERVER}/api/overlay-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(engine.getConfig())
      });
    } catch (e) {
      console.log('配置保存失败');
    }
  }

  // --- Sync UI sliders with engine ---
  function syncControlsFromEngine() {
    const cfg = engine.getConfig();
    offsetSlider.value = cfg.offset;
    offsetVal.textContent = `${cfg.offset > 0 ? '+' : ''}${cfg.offset}s`;
    fontSizeSlider.value = cfg.fontSize;
    fontSizeVal.textContent = `${cfg.fontSize}px`;
    opacitySlider.value = cfg.opacity;
    opacityVal.textContent = `${Math.round(cfg.opacity * 100)}%`;
    speedSlider.value = cfg.speed;
    speedVal.textContent = `${cfg.speed}s`;
    areaSlider.value = cfg.area;
    areaVal.textContent = `${cfg.area}%`;
  }

  function applyAndSave(updates) {
    engine.configure(updates);
    syncControlsFromEngine();
    saveConfig();
  }

  // --- Danmaku loading ---
  async function loadDanmaku(bvid) {
    if (!bvid) {
      setStatus('请输入 BV 号或 EP 号');
      return;
    }
    setStatus('加载弹幕中...');
    try {
      const res = await fetch(`${SERVER}/api/danmu?id=${encodeURIComponent(bvid)}&strategy=seg.so`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载失败');
      engine.load(data.danmus);
      currentBvid = bvid;
      setStatus(`已加载 ${data.danmus.length} 条弹幕 · ${bvid}`);
    } catch (err) {
      setStatus(`加载失败: ${err.message}`);
    }
  }

  // --- Simulation timer (standalone mode, no video) ---
  function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    simStartPerf = performance.now();
    simTime = engine.danmus.length > 0 ? Math.max(0, engine.danmus[0].time - 2) : simTime;
    engine.start(simTime);
    playPauseBtn.textContent = '暂停';
    playPauseBtn.classList.add('primary');
    updateTimeDisplay();
  }

  function pauseSimulation() {
    if (!isRunning) return;
    isRunning = false;
    simTime = getSimulatedTime();
    engine.pause();
    playPauseBtn.textContent = '开始';
    playPauseBtn.classList.remove('primary');
    updateTimeDisplay();
  }

  function getSimulatedTime() {
    return simTime + (performance.now() - simStartPerf) / 1000;
  }

  // --- Time & seeking via progress bar ---
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function seekTo(seconds) {
    simTime = Math.max(0, Math.min(seconds, maxDuration));
    simStartPerf = performance.now();
    engine.seek(simTime);
    if (isRunning) engine.resume(simTime);
  }

  function updateTimeDisplay() {
    if (isSeeking) return;
    const t = isRunning ? getSimulatedTime() : simTime;
    seekBar.value = Math.round(t);
    seekTimeLabel.textContent = formatTime(t);
  }

  // Override engine's loop to use simulated time (no video element in overlay mode)
  engine._loop = function () {
    if (!this._running || this._paused) return;
    const tick = (now) => {
      if (!this._running || this._paused) { this._loopId = 0; return; }
      this._tickActive(now);
      const currentTime = simTime + (now - simStartPerf) / 1000;
      this._flush(currentTime);
      updateTimeDisplay();
      this._loopId = requestAnimationFrame(tick);
    };
    this._loopId = requestAnimationFrame(tick);
  };

  // --- Panel toggle ---
  function togglePanel() {
    if (panelVisible) hidePanel();
    else showPanel();
  }

  function showPanel() {
    panelVisible = true;
    controlPanel.classList.add('visible');
    if (window.electronAPI) window.electronAPI.setClickThrough(false);
  }

  function hidePanel() {
    panelVisible = false;
    controlPanel.classList.remove('visible');
    if (window.electronAPI) window.electronAPI.setClickThrough(true);
  }

  // --- Status ---
  function setStatus(msg) {
    statusText.textContent = msg;
  }

  // --- Event handlers ---
  loadBtn.addEventListener('click', () => loadDanmaku(bvidInput.value.trim()));

  bvidInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDanmaku(bvidInput.value.trim());
  });

  playPauseBtn.addEventListener('click', () => {
    if (isRunning) pauseSimulation();
    else startSimulation();
  });

  offsetSlider.addEventListener('input', () => {
    applyAndSave({ offset: Number(offsetSlider.value) });
  });

  fontSizeSlider.addEventListener('input', () => {
    applyAndSave({ fontSize: Number(fontSizeSlider.value) });
  });

  opacitySlider.addEventListener('input', () => {
    applyAndSave({ opacity: Number(opacitySlider.value) });
  });

  // Seek bar: drag preview (no seek yet, just update label)
  seekBar.addEventListener('input', () => {
    isSeeking = true;
    seekTimeLabel.textContent = formatTime(Number(seekBar.value));
  });

  // Seek bar: drag complete — perform the seek
  seekBar.addEventListener('change', () => {
    seekTo(Number(seekBar.value));
    isSeeking = false;
    setStatus(`跳转到 ${formatTime(Number(seekBar.value))}`);
  });

  timestampBtn.addEventListener('click', () => {
    const enabled = !engine.showTimestamps;
    engine.configure({ showTimestamps: enabled });
    engine.seek(isRunning ? getSimulatedTime() : simTime);
    if (isRunning) engine.resume(isRunning ? getSimulatedTime() : simTime);
    timestampBtn.textContent = enabled ? '隐藏时间戳' : '显示时间戳';
    timestampBtn.classList.toggle('primary', enabled);
  });

  speedSlider.addEventListener('input', () => {
    applyAndSave({ speed: Number(speedSlider.value) });
  });

  areaSlider.addEventListener('input', () => {
    applyAndSave({ area: Number(areaSlider.value) });
  });

  resetBtn.addEventListener('click', () => {
    engine.reset();
    simTime = 0;
    simStartPerf = performance.now();
    if (isRunning) engine.start(simTime);
    updateTimeDisplay();
    setStatus('已重置');
  });

  exitBtn.addEventListener('click', () => {
    if (window.electronAPI) {
      window.electronAPI.closeWindow();
    } else {
      window.close();
    }
  });

  // --- Keyboard shortcuts (for browser standalone mode) ---
  document.addEventListener('keydown', (e) => {
    // Don't capture when typing in input
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (isRunning) pauseSimulation();
        else startSimulation();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) {
          simTime = Math.max(0, (isRunning ? getSimulatedTime() : simTime) - 2);
        } else {
          simTime = Math.max(0, (isRunning ? getSimulatedTime() : simTime) - 0.5);
        }
        simStartPerf = performance.now();
        engine.seek(simTime);
        if (isRunning) engine.resume(simTime);
        updateTimeDisplay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) {
          simTime = (isRunning ? getSimulatedTime() : simTime) + 2;
        } else {
          simTime = (isRunning ? getSimulatedTime() : simTime) + 0.5;
        }
        simStartPerf = performance.now();
        engine.seek(simTime);
        if (isRunning) engine.resume(simTime);
        updateTimeDisplay();
        break;
      case 'ArrowUp':
        e.preventDefault();
        applyAndSave({ opacity: Math.min(1, engine.opacity + 0.05) });
        break;
      case 'ArrowDown':
        e.preventDefault();
        applyAndSave({ opacity: Math.max(0.1, engine.opacity - 0.05) });
        break;
      case 'o':
      case 'O':
        e.preventDefault();
        togglePanel();
        break;
      case 'Escape':
        hidePanel();
        break;
    }
  });

  // --- Electron IPC listeners ---
  if (window.electronAPI) {
    window.electronAPI.onShortcut('play-pause', () => {
      if (isRunning) pauseSimulation();
      else startSimulation();
    });

    window.electronAPI.onShortcut('seek-forward', () => {
      simTime = (isRunning ? getSimulatedTime() : simTime) + 0.5;
      simStartPerf = performance.now();
      engine.seek(simTime);
      if (isRunning) engine.resume(simTime);
      updateTimeDisplay();
    });

    window.electronAPI.onShortcut('seek-backward', () => {
      simTime = Math.max(0, (isRunning ? getSimulatedTime() : simTime) - 0.5);
      simStartPerf = performance.now();
      engine.seek(simTime);
      if (isRunning) engine.resume(simTime);
      updateTimeDisplay();
    });

    window.electronAPI.onShortcut('seek-forward-big', () => {
      simTime = (isRunning ? getSimulatedTime() : simTime) + 2;
      simStartPerf = performance.now();
      engine.seek(simTime);
      if (isRunning) engine.resume(simTime);
      updateTimeDisplay();
    });

    window.electronAPI.onShortcut('seek-backward-big', () => {
      simTime = Math.max(0, (isRunning ? getSimulatedTime() : simTime) - 2);
      simStartPerf = performance.now();
      engine.seek(simTime);
      if (isRunning) engine.resume(simTime);
      updateTimeDisplay();
    });

    window.electronAPI.onShortcut('opacity-up', () => {
      applyAndSave({ opacity: Math.min(1, engine.opacity + 0.05) });
    });

    window.electronAPI.onShortcut('opacity-down', () => {
      applyAndSave({ opacity: Math.max(0.1, engine.opacity - 0.05) });
    });

    window.electronAPI.onShortcut('fontsize-up', () => {
      applyAndSave({ fontSize: Math.min(72, engine.fontSize + 2) });
    });

    window.electronAPI.onShortcut('fontsize-down', () => {
      applyAndSave({ fontSize: Math.max(14, engine.fontSize - 2) });
    });

    window.electronAPI.onShortcut('toggle-panel', () => togglePanel());

    window.electronAPI.onShortcut('load-danmaku', () => {
      showPanel();
      bvidInput.focus();
    });
  }

  // --- Indicator fade ---
  function fadeIndicator() {
    if (fadeTimer) clearTimeout(fadeTimer);
    statusIndicator.classList.remove('fading');
    fadeTimer = setTimeout(() => {
      statusIndicator.classList.add('fading');
    }, 3000);
  }

  // --- Init ---
  loadConfig();

  setStatus('就绪 — 按 Space 开始/暂停, O 打开控制面板, ← → 微调时间');

  // Auto-show panel on first launch so user knows overlay is running
  if (window.electronAPI) {
    showPanel();
    fadeIndicator();
  } else {
    // In browser mode, show panel by default too
    showPanel();
    fadeIndicator();
  }

  // Fade indicator on panel toggle
  const origShowPanel = showPanel;
  showPanel = function () {
    origShowPanel();
    statusIndicator.classList.remove('fading');
    if (fadeTimer) clearTimeout(fadeTimer);
  };
  const origHidePanel = hidePanel;
  hidePanel = function () {
    origHidePanel();
    fadeIndicator();
  };

  console.log('Danmaku Overlay ready');
})();
