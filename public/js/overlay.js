/**
 * overlay.js — logic for the transparent danmaku overlay page.
 * Works standalone in a browser (for testing) and inside Electron.
 */

(function () {
  const SERVER = `http://${location.hostname}:${location.port || 3000}`;

  async function api(url, options) {
    const res = await fetch(url, options);
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.message || '请求失败');
    return json.data;
  }

  // DOM
  const danmakuLayer = document.getElementById('danmaku-layer');
  const controlPanel = document.getElementById('control-panel');
  const bvidInput = document.getElementById('bvid-input');
  const sourceSelect = document.getElementById('source-select');
  const zhibo8TypeSelect = document.getElementById('zhibo8-type-select');
  const zhibo8TypeRow = document.getElementById('zhibo8-type-row');
  const txspConfigRow = document.getElementById('txsp-config-row');
  const txspRoomId = document.getElementById('txsp-room-id');
  const txspProgramId = document.getElementById('txsp-program-id');
  const folderRow = document.getElementById('folder-row');
  const videoFileRow = document.getElementById('video-file-row');
  const loadBtn = document.getElementById('load-btn');
  const refreshBtn = document.getElementById('refresh-btn');
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
  const timeInput = document.getElementById('time-input');
  const jumpBtn = document.getElementById('jump-btn');
  const folderSelect = document.getElementById('folder-select');
  const videoFileSelect = document.getElementById('video-file-select');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsGroup = document.getElementById('settings-group');
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
  let lastFolder = '';
  let zhibo8Timer = null;
  let zhibo8LastMaxId = 0;
  let txspTimer = null;
  let txspLastSeq = 0;
  let txspCursor = '';
  let txspCookie = '';

  // --- Load saved config from server ---
  async function loadConfig() {
    try {
      const cfg = await api(`${SERVER}/api/overlay-config`);
      if (cfg.maxDuration) {
        maxDuration = cfg.maxDuration;
        seekBar.max = maxDuration;
      }
      engine.configure(cfg);
      syncControlsFromEngine();
      if (cfg.lastFolder) lastFolder = cfg.lastFolder;
    } catch (e) {
      console.log('无法加载配置，使用默认值');
    }
  }

  async function saveConfig() {
    try {
      const cfg = engine.getConfig();
      cfg.lastFolder = lastFolder;
      await fetch(`${SERVER}/api/overlay-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
    } catch (e) {
      console.log('配置保存失败');
    }
  }

  async function readFolderHistory() {
    try {
      return await api(`${SERVER}/api/folder-history`) || {};
    } catch { return {}; }
  }

  async function saveFolderHistory(dir, name) {
    try {
      await fetch(`${SERVER}/api/folder-history`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, name })
      });
    } catch { /* ignore */ }
  }

  let currentVideoFileName = '';

  function saveCurrentTime() {
    if (!currentVideoFileName) return;
    const time = isRunning ? getSimulatedTime() : simTime;
    if (time <= 0) return;
    fetch(`${SERVER}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentVideoFileName, time: Math.round(time) })
    }).catch(() => {});
  }

  async function restorePlayTime(fileName) {
    currentVideoFileName = fileName;
    try {
      const data = await api(`${SERVER}/api/progress?id=${encodeURIComponent(fileName)}`);
      if (data && data.time > 0) {
        seekTo(data.time);
        updateTimeDisplay();
        setStatus(`恢复播放时间 ${formatTime(data.time)}`);
      }
    } catch { /* ignore */ }
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
  async function loadDanmaku(id, { refresh = false } = {}) {
    const source = sourceSelect.value;
    if (!id && source !== 'txsp') {
      setStatus('请输入 BV号、EP号 或 VID');
      return;
    }
    const label = { bili: 'B站', qq: '腾讯', mango: '芒果', zhibo8: '直播吧' }[source] || source;

    clearPollTimers();

    if (source === 'zhibo8') {
      if (refresh) {
        engine.load([]);
        setStatus(`重新轮询${label}弹幕...`);
      } else {
        setStatus(`开始轮询${label}弹幕...`);
      }
      currentBvid = id;
      zhibo8LastMaxId = 0;

      const poll = async () => {
        try {
          const type = zhibo8TypeSelect.value;
          const params = new URLSearchParams({ source, id, type, lastMaxId: String(zhibo8LastMaxId) });
          const data = await api(`${SERVER}/api/danmaku?${params.toString()}`);
          if (data.danmus.length) {
            const now = getSimulatedTime();
            for (const d of data.danmus) {
              d.time = now;
              if (d.rawTime) d.ctime = new Date(d.rawTime).getTime() / 1000;
            }
            engine.append(data.danmus);
            if (!isRunning) startSimulation();
            if (data.maxId) zhibo8LastMaxId = data.maxId;
            setStatus(`已加载 ${engine.danmus.length} 条弹幕 · ${id}`);
          }
        } catch (err) {
          setStatus(`轮询失败: ${err.message}`);
        }
      };

      poll();
      zhibo8Timer = setInterval(poll, 2000);
      return;
    }

    if (source === 'txsp') {
      const roomId = txspRoomId.value.trim();
      const programId = txspProgramId.value.trim();
      if (!roomId || !programId) {
        setStatus('请输入 Room ID 和 Program ID');
        return;
      }
      setStatus(`开始轮询${label}弹幕...`);
      engine.load([]);
      currentBvid = `${roomId}_${programId}`;
      txspLastSeq = 0;
      txspCursor = '';

      const poll = async () => {
        try {
          const params = new URLSearchParams({
            source: 'txsp', roomId, programId,
            lastSeq: String(txspLastSeq), cursor: txspCursor,
            txspCookie
          });
          const data = await api(`${SERVER}/api/danmaku?${params.toString()}`);
          if (data.danmus.length) {
            const now = getSimulatedTime();
            for (const d of data.danmus) d.time = now;
            engine.append(data.danmus);
            if (!isRunning) startSimulation();
            if (data.maxSeq) txspLastSeq = data.maxSeq;
            if (data.cursor) txspCursor = data.cursor;
            setStatus(`已加载 ${engine.danmus.length} 条弹幕 · ${roomId}`);
          }
          const interval = data.pullInterval || 3000;
          txspTimer = setTimeout(poll, interval);
        } catch (err) {
          setStatus(`轮询失败: ${err.message}`);
          txspTimer = setTimeout(poll, 3000);
        }
      };

      poll();
      return;
    }

    setStatus(`${refresh ? '重新' : ''}加载${label}弹幕中...`);
    try {
      const params = new URLSearchParams({ source, id });
      if (source === 'bili') params.set('strategy', 'seg.so');
      if (source === 'qq') params.set('duration', String(maxDuration * 1000));
      if (refresh) params.set('refresh', '1');
      const data = await api(`${SERVER}/api/danmaku?${params.toString()}`);
      engine.load(data.danmus);
      currentBvid = id;
      setStatus(`已加载 ${data.danmus.length} 条弹幕${refresh ? '（已刷新）' : ''} · ${id}`);
    } catch (err) {
      setStatus(`加载失败: ${err.message}`);
    }
  }

  function clearPollTimers() {
    if (zhibo8Timer) { clearInterval(zhibo8Timer); zhibo8Timer = null; }
    if (txspTimer) { clearTimeout(txspTimer); txspTimer = null; }
  }

  // --- Simulation timer (standalone mode, no video) ---
  function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    simStartPerf = performance.now();
    // Only auto-set if user hasn't already jumped somewhere
    if (simTime === 0 && engine.danmus.length > 0) {
      simTime = Math.max(0, engine.danmus[0].time - 2);
    }
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
    saveCurrentTime();
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
    saveCurrentTime();
    if (isRunning) engine.resume(simTime);
  }

  function parseTime(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    // Colon format: "1:23:45" or "23:45" or "45"
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.some(isNaN)) return null;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return null;
    }
    // Digit-only format: 2513→25:13, 0513→5:13, 12513→1:25:13, 90→90s
    if (/^\d+$/.test(s)) {
      const len = s.length;
      if (len <= 2) return parseInt(s, 10);
      if (len === 3) return parseInt(s[0], 10) * 60 + parseInt(s.slice(1), 10);
      if (len === 4) return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
      if (len === 5) return parseInt(s[0], 10) * 3600 + parseInt(s.slice(1, 3), 10) * 60 + parseInt(s.slice(3), 10);
      if (len >= 6) return parseInt(s.slice(0, 2), 10) * 3600 + parseInt(s.slice(2, 4), 10) * 60 + parseInt(s.slice(4), 10);
    }
    return parseFloat(s) || null;
  }

  function jumpToTime(str) {
    const t = parseTime(str);
    if (t == null) { setStatus('格式错误 (如 1:23:45 或 90)'); return; }
    seekTo(t);
    updateTimeDisplay();
    setStatus(`跳转到 ${formatTime(t)}`);
  }

  function updateTimeDisplay() {
    if (isSeeking) return;
    const t = isRunning ? getSimulatedTime() : simTime;
    seekBar.value = Math.round(t);
    seekTimeLabel.textContent = formatTime(t);
    if (document.activeElement !== timeInput) {
      timeInput.value = formatTime(t);
    }
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
  refreshBtn.addEventListener('click', () => loadDanmaku(bvidInput.value.trim(), { refresh: true }));

  // txsp 粘贴智能提取 room_id / program_id
  bvidInput.addEventListener('paste', () => {
    if (sourceSelect.value !== 'txsp') return;
    setTimeout(() => {
      const raw = bvidInput.value;
      const roomMatch = raw.match(/"room_id"\s*:\s*(\d+)/);
      const progMatch = raw.match(/"program_id"\s*:\s*"(\d+)"/);
      const cookieMatch = raw.match(/"cookie"\s*:\s*"([^"]+)"/) || raw.match(/-b\s+'([^']+)'/);
      if (roomMatch) txspRoomId.value = roomMatch[1];
      if (progMatch) txspProgramId.value = progMatch[1];
      if (cookieMatch) txspCookie = cookieMatch[1];
      if (roomMatch || progMatch) {
        bvidInput.value = '';
        setStatus('已自动提取 Room ID 和 Program ID');
      }
    }, 100);
  });

  bvidInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDanmaku(bvidInput.value.trim());
  });

  sourceSelect.addEventListener('change', () => {
    const src = sourceSelect.value;
    clearPollTimers();
    const isZhibo8 = src === 'zhibo8';
    const isTxsp = src === 'txsp';
    zhibo8TypeRow.style.display = isZhibo8 ? '' : 'none';
    txspConfigRow.style.display = isTxsp ? '' : 'none';
    folderRow.style.display = (isZhibo8 || isTxsp) ? 'none' : '';
    videoFileRow.style.display = (isZhibo8 || isTxsp) ? 'none' : '';
    if (src === 'bili') bvidInput.placeholder = '输入 BV 号或 EP 号';
    else if (src === 'qq') bvidInput.placeholder = '输入 VID';
    else if (src === 'mango') bvidInput.placeholder = '输入 HHMMSS/videoId';
    else if (isZhibo8) bvidInput.placeholder = '输入比赛ID';
    else bvidInput.placeholder = '输入比赛ID（不用填）';
    const name = videoFileSelect.value || bvidInput.value;
    if (name) {
      bvidInput.value = getVideoIdForSource(name, src);
    }
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
    timeInput.value = formatTime(Number(seekBar.value));
    setStatus(`跳转到 ${formatTime(Number(seekBar.value))}`);
  });

  // Time input: manual hh:mm:ss jump
  jumpBtn.addEventListener('click', () => jumpToTime(timeInput.value));
  timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jumpToTime(timeInput.value);
  });

  settingsBtn.addEventListener('click', () => {
    const hidden = settingsGroup.style.display === 'none';
    settingsGroup.style.display = hidden ? '' : 'none';
    settingsBtn.textContent = hidden ? '收起设置' : '弹幕设置';
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

  resetBtn.addEventListener('click', async () => {
    if (currentVideoFileName) {
      try {
        const data = await api(`${SERVER}/api/progress?id=${encodeURIComponent(currentVideoFileName)}`);
        if (data && data.time > 0) {
          engine.reset();
          seekTo(data.time);
          updateTimeDisplay();
          setStatus(`已恢复到服务器进度: ${formatTime(data.time)}`);
          return;
        }
      } catch {}
    }
    engine.reset();
    simTime = 0;
    simStartPerf = performance.now();
    if (isRunning) engine.start(simTime);
    updateTimeDisplay();
    setStatus('已重置（无服务器记录）');
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

    const mod = e.ctrlKey || e.metaKey;

    switch (e.key) {
      case ' ':
        if (!mod) return;
        e.preventDefault();
        if (isRunning) pauseSimulation();
        else startSimulation();
        break;
      case 'ArrowLeft':
        if (!mod) return;
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
        if (!mod) return;
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
        if (!mod) return;
        e.preventDefault();
        if (e.shiftKey) {
          applyAndSave({ fontSize: Math.min(72, engine.fontSize + 2) });
        } else {
          applyAndSave({ opacity: Math.min(1, engine.opacity + 0.05) });
        }
        break;
      case 'ArrowDown':
        if (!mod) return;
        e.preventDefault();
        if (e.shiftKey) {
          applyAndSave({ fontSize: Math.max(14, engine.fontSize - 2) });
        } else {
          applyAndSave({ opacity: Math.max(0.1, engine.opacity - 0.05) });
        }
        break;
      case 'o':
      case 'O':
        if (!mod) return;
        e.preventDefault();
        togglePanel();
        break;
      case 'Escape':
        e.preventDefault();
        togglePanel();
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

  // --- Folder & video file selection ---
  function detectVideoId(name) {
    if (!name) return '';
    const base = String(name).replace(/\.[^.]+$/, '');
    const bv = base.match(/BV[0-9A-Za-z]+/i);
    if (bv) return bv[0];
    const ep = base.match(/(?:^|[_\s-])(ep\d{4,})(?=$|[_\s-])/i);
    if (ep) return ep[1];
    return '';
  }

  function detectVid(name) {
    if (!name) return '';
    const base = String(name).replace(/\.[^.]+$/, '');
    const m = base.match(/(?:^|[_\s-])([a-z][a-z0-9]{9,11})(?=$|[_\s-.])/i);
    return m ? m[1] : '';
  }

  function getVideoIdForSource(name, source) {
    if (source === 'qq') return detectVid(name);
    return detectVideoId(name);
  }

  async function loadFolders() {
    try {
      const folders = await api(`${SERVER}/api/folders`);
      folderSelect.innerHTML = '<option value="">-- 选择文件夹 --</option>';
      if (!folders || !folders.length) return;
      folders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.name;
        folderSelect.appendChild(opt);
      });
      // Auto-select last used folder
      if (lastFolder) {
        const match = [...folderSelect.options].find(o => o.value === lastFolder);
        if (match) {
          match.selected = true;
          folderSelect.dispatchEvent(new Event('change'));
          return;
        }
      }
      // Fallback: auto-select "movie"
      const movieOpt = [...folderSelect.options].find(o => o.textContent.toLowerCase() === 'movie');
      if (movieOpt) {
        movieOpt.selected = true;
        folderSelect.dispatchEvent(new Event('change'));
      }
    } catch (e) { console.log('加载文件夹失败'); }
  }

  async function loadFilesForFolder(folderPath) {
    videoFileSelect.innerHTML = '<option value="">-- 加载中... --</option>';
    try {
      const files = await api(`${SERVER}/api/video-files?folder=${encodeURIComponent(folderPath)}`);
      videoFileSelect.innerHTML = '<option value="">-- 选择视频文件 --</option>';
      if (!files || !files.length) return;
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.name;
        const vid = detectVideoId(f.name);
        opt.textContent = vid ? `${f.name}  [${vid}]` : f.name;
        videoFileSelect.appendChild(opt);
      });
      // Auto-select last played video in this folder
      const history = await readFolderHistory();
      const savedName = history[folderPath];
      if (savedName) {
        const match = [...videoFileSelect.options].find(o => o.value === savedName);
        if (match) {
          match.selected = true;
          videoFileSelect.dispatchEvent(new Event('change'));
        }
      }
    } catch (e) {
      videoFileSelect.innerHTML = '<option value="">-- 加载失败 --</option>';
    }
  }

  folderSelect.addEventListener('change', () => {
    const folder = folderSelect.value;
    if (!folder) {
      videoFileSelect.innerHTML = '<option value="">-- 选择视频文件 --</option>';
      return;
    }
    lastFolder = folder;
    saveConfig();
    loadFilesForFolder(folder);
  });

  videoFileSelect.addEventListener('change', async () => {
    const selected = videoFileSelect.value;
    if (!selected) return;
    // 保存旧视频的播放时间
    saveCurrentTime();
    // 自动检测弹幕源
    const biliId = detectVideoId(selected);
    const tencentId = detectVid(selected);
    if (tencentId) {
      sourceSelect.value = 'qq';
      bvidInput.value = tencentId;
    } else if (biliId) {
      sourceSelect.value = 'bili';
      bvidInput.value = biliId;
    } else {
      bvidInput.value = '';
    }
    sourceSelect.dispatchEvent(new Event('change'));
    const folder = folderSelect.value;
    if (folder && selected) {
      saveFolderHistory(folder, selected);
    }
    // 恢复新视频的播放时间
    await restorePlayTime(selected);
    // 自动加载弹幕
    loadDanmaku(bvidInput.value.trim());
  });

  // --- Panel dragging ---
  let dragInfo = null;
  const dragHandle = document.getElementById('panel-drag-handle');

  // 隐藏面板按钮
  const hideBtn = document.createElement('span');
  hideBtn.textContent = '✕';
  hideBtn.title = '隐藏面板';
  hideBtn.style.cssText = 'font-size:16px;cursor:pointer;color:#a0a8c0;padding:0 4px;line-height:1;';
  hideBtn.addEventListener('click', (e) => { e.stopPropagation(); hidePanel(); });
  dragHandle.appendChild(hideBtn);

  dragHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rect = controlPanel.getBoundingClientRect();
    dragInfo = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragInfo) return;
    controlPanel.style.left = `${dragInfo.startLeft + e.clientX - dragInfo.startX}px`;
    controlPanel.style.top = `${dragInfo.startTop + e.clientY - dragInfo.startY}px`;
    controlPanel.style.bottom = 'auto';
    controlPanel.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => { dragInfo = null; });

  dragHandle.addEventListener('dblclick', () => {
    controlPanel.style.left = '';
    controlPanel.style.top = '';
    controlPanel.style.bottom = '40px';
    controlPanel.style.transform = 'translateX(-50%)';
  });

  // --- IINA 播放状态同步 ---
  let iinaPaused = false;
  let iinaLastTime = 0;
  let iinaLastPath = '';
  setInterval(async () => {
    try {
      const state = await api(`${SERVER}/api/iina-state`);
      if (state.paused !== iinaPaused) {
        iinaPaused = state.paused;
        if (iinaPaused && isRunning) {
          pauseSimulation();
          setStatus('IINA 已暂停');
        } else if (!iinaPaused && !isRunning) {
          startSimulation();
          setStatus('IINA 已播放');
        }
      }
      // IINA 快进/快退 → 弹幕跟随跳转
      if (state.time > 0 && state.path === iinaLastPath) {
        const gap = Math.abs(state.time - iinaLastTime);
        if (gap > 30 && iinaLastTime > 0) {
          seekTo(state.time);
          updateTimeDisplay();
          setStatus(`IINA 跳转到 ${formatTime(state.time)}`);
        }
      }
      iinaLastTime = state.time;
      // IINA 文件切换 → 自动选文件夹 + 视频
      if (state.path && state.path !== iinaLastPath) {
        iinaLastPath = state.path;
        const fileName = state.path.split('/').pop();
        const dirPath = state.path.replace(/\/[^/]+$/, '');
        const folderOpt = [...folderSelect.options].find(o => o.value === dirPath);
        if (!folderOpt) return;
        if (folderOpt.value === folderSelect.value) {
          // 同文件夹，直接选视频
          const videoOpt = [...videoFileSelect.options].find(o => o.value === fileName);
          if (videoOpt && videoOpt.value !== videoFileSelect.value) {
            videoFileSelect.value = videoOpt.value;
            videoFileSelect.dispatchEvent(new Event('change'));
          }
        } else {
          // 切换文件夹
          folderSelect.value = folderOpt.value;
          folderSelect.dispatchEvent(new Event('change'));
          // 轮询等文件列表加载完再选视频
          let retry = 0;
          const trySelect = setInterval(() => {
            retry++;
            const vOpt = [...videoFileSelect.options].find(o => o.value === fileName);
            if (vOpt) {
              clearInterval(trySelect);
              videoFileSelect.value = vOpt.value;
              videoFileSelect.dispatchEvent(new Event('change'));
            } else if (retry > 10) {
              clearInterval(trySelect);
            }
          }, 300);
        }
      }
    } catch {}
  }, 2000);

  // --- Init ---
  (async () => {
    await loadConfig();
    await loadFolders();
  })();

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
