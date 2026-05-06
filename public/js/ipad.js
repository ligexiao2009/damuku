/**
 * ipad.js — 专为 iPad 触摸操作优化的弹幕控制器
 * 默认直播吧弹幕源，支持直播流 + 实时弹幕轮询
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
  const panel = document.getElementById('control-panel');
  const indicator = document.getElementById('status-indicator');
  const danmakuLayer = document.getElementById('danmaku-layer');
  const sourceSelect = document.getElementById('source-select');
  const zhibo8TypeSelect = document.getElementById('zhibo8-type-select');
  const txspConfigRow = document.getElementById('txsp-config-row');
  const txspRoomId = document.getElementById('txsp-room-id');
  const txspProgramId = document.getElementById('txsp-program-id');
  const bvidInput = document.getElementById('bvid-input');
  const loadBtn = document.getElementById('load-btn');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const statusText = document.getElementById('status-text');
  const seekTimeLabel = document.getElementById('seek-time');
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
  const settingsBtn = document.getElementById('settings-btn');
  const settingsGroup = document.getElementById('settings-group');
  const timestampBtn = document.getElementById('timestamp-btn');
  const resetBtn = document.getElementById('reset-btn');
  const exitBtn = document.getElementById('exit-btn');

  // Engine
  const engine = new DanmakuEngine(danmakuLayer, {
    speed: 18, area: 25, offset: 0, fontSize: 32, opacity: 1
  });

  // State
  let isRunning = false;
  let simTime = 0;
  let simStartPerf = 0;
  let zhibo8Timer = null;
  let zhibo8LastMaxId = 0;
  let txspTimer = null;
  let txspLastSeq = 0;
  let txspCursor = '';
  let txspCookie = '';
  let hideTimer = null;

  // --- Panel control ---
  function isPanelVisible() { return panel.classList.contains('visible'); }
  function showPanel() {
    panel.classList.add('visible');
    indicator.classList.remove('fading');
    indicator.style.animation = 'none';
    resetHideTimer();
  }
  function hidePanel() {
    panel.classList.remove('visible');
    indicator.classList.add('fading');
    indicator.style.animation = 'dotPulse 2.5s ease-in-out infinite';
    clearHideTimer();
  }
  function togglePanel() { if (isPanelVisible()) hidePanel(); else showPanel(); }
  function resetHideTimer() {
    clearHideTimer();
    hideTimer = setTimeout(hidePanel, 20000);
  }
  function clearHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // --- Time helpers ---
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getSimulatedTime() {
    return simTime + (performance.now() - simStartPerf) / 1000;
  }

  function updateTimeDisplay() {
    seekTimeLabel.textContent = formatTime(isRunning ? getSimulatedTime() : simTime);
  }

  // --- Simulation ---
  function startSimulation() {
    if (isRunning) return;
    isRunning = true;
    simStartPerf = performance.now();
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

  // --- Danmaku loading ---
  function clearPollTimers() {
    if (zhibo8Timer) { clearInterval(zhibo8Timer); zhibo8Timer = null; }
    if (txspTimer) { clearTimeout(txspTimer); txspTimer = null; }
  }

  async function loadDanmaku(id) {
    const source = sourceSelect.value;
    const label = { zhibo8: '直播吧', txsp: '腾讯体育', bili: 'B站', qq: '腾讯', mango: '芒果', iqiyi: '爱奇艺' }[source] || source;
    clearPollTimers();

    if (source === 'zhibo8') {
      if (!id) { setStatus('请输入比赛ID'); return; }
      zhibo8LastMaxId = 0;

      const type = zhibo8TypeSelect.value;
      setStatus(`开始轮询${label}弹幕...`);

      const poll = async () => {
        try {
          const params = new URLSearchParams({ source: 'zhibo8', id, type, lastMaxId: String(zhibo8LastMaxId) });
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

    // VOD 弹幕（bili, qq, mango, iqiyi）
    if (!id) { setStatus('请输入ID'); return; }
    setStatus(`加载${label}弹幕中...`);
    try {
      const params = new URLSearchParams({ source, id });
      const data = await api(`${SERVER}/api/danmaku?${params.toString()}`);
      engine.load(data.danmus);
      setStatus(`已加载 ${data.danmus.length} 条弹幕 · ${id}`);
      if (!isRunning) startSimulation();
    } catch (err) {
      setStatus(`加载失败: ${err.message}`);
    }
  }

  function setStatus(msg) {
    if (statusText) statusText.textContent = msg;
  }

  // --- Settings ---
  function applySetting(key, value) {
    engine.configure({ [key]: value });
    syncControls();
  }

  function syncControls() {
    offsetSlider.value = engine.offset;
    offsetVal.textContent = engine.offset + 's';
    fontSizeSlider.value = engine.fontSize;
    fontSizeVal.textContent = engine.fontSize + 'px';
    opacitySlider.value = engine.opacity;
    opacityVal.textContent = Math.round(engine.opacity * 100) + '%';
    speedSlider.value = engine.speed;
    speedVal.textContent = engine.speed + 's';
    areaSlider.value = engine.area;
    areaVal.textContent = engine.area + '%';
  }

  // --- Event handlers ---
  loadBtn.addEventListener('click', () => loadDanmaku(bvidInput.value.trim()));
  bvidInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDanmaku(bvidInput.value.trim());
  });

  // txsp 粘贴智能提取 room_id / program_id / cookie
  bvidInput.addEventListener('paste', () => {
    if (sourceSelect.value !== 'txsp') return;
    setTimeout(() => {
      const raw = bvidInput.value.trim();

      // 1. JSON 格式（bookmarklet/extract 脚本输出）
      const roomMatch = raw.match(/"room_?id"\s*:\s*(\d+)/i);
      const progMatch = raw.match(/"program_?id"\s*:\s*"?(\d+)"?/i);
      const cookieMatch = raw.match(/"cookie"\s*:\s*"((?:[^"\\]|\\.)*)"/i) || raw.match(/-b\s+'([^']+)'/);

      // 2. 腾讯体育 URL 格式：提取 program_id
      // https://v.qq.com/live/p/newtopic/366830/index.html
      let urlProgMatch = null;
      let urlRoomMatch = null;
      try {
        const u = new URL(raw);
        if (u.hostname.includes('qq.com')) {
          urlProgMatch = u.pathname.match(/\/newtopic\/(\d+)/i) || u.pathname.match(/\/program\/(\d+)/i);
          urlRoomMatch = u.pathname.match(/\/room\/(\d+)/i);
          // 尝试从 URL 参数提取
          urlProgMatch = urlProgMatch || u.searchParams.get('program_id');
          urlRoomMatch = urlRoomMatch || u.searchParams.get('room_id');
        }
      } catch {}

      // 3. 纯数字格式（如直播吧 matchId）
      const numericMatch = /^\d{4,}$/.test(raw) ? raw : null;

      if (roomMatch) txspRoomId.value = roomMatch[1];
      if (progMatch) txspProgramId.value = progMatch[1];
      if (cookieMatch) { txspCookie = cookieMatch[1]; console.log('[txsp-paste] cookie 提取:', txspCookie.slice(0,60) + '...' + txspCookie.slice(-20)); }
      if (urlProgMatch) txspProgramId.value = urlProgMatch[1];
      if (urlRoomMatch) txspRoomId.value = urlRoomMatch[1];

      const hasRoom = !!(roomMatch || urlRoomMatch);
      const hasProg = !!(progMatch || urlProgMatch);
      const hasCookie = !!cookieMatch;

      if (hasRoom || hasProg) {
        bvidInput.value = '';
        const parts = [];
        if (hasRoom) parts.push('Room ID');
        if (hasProg) parts.push('Program ID');
        if (hasCookie) parts.push('Cookie');
        setStatus('已提取: ' + parts.join(' + '));
        saveSettings();
      } else if (numericMatch) {
        bvidInput.value = '';
        setStatus('数字已提取: ' + numericMatch);
        saveSettings();
      }
    }, 100);
  });

  // 一键粘贴直播地址：第一次清空，第二次粘贴
  var pasteBtn = document.getElementById('paste-stream-btn');
  if (pasteBtn) {
    var pastePending = false;
    pasteBtn.addEventListener('click', async () => {
      var input = document.getElementById('streamUrl');
      if (!input) return;
      if (!pastePending) {
        input.value = '';
        pasteBtn.textContent = '📋✓';
        pasteBtn.title = '再次点击粘贴剪贴板内容';
        pastePending = true;
      } else {
        input.focus();
        input.select();
        setStatus('请长按输入框粘贴');
        pasteBtn.textContent = '📋';
        pasteBtn.title = '清空直播地址';
        pastePending = false;
      }
    });
  }

  sourceSelect.addEventListener('change', () => {
    const z = sourceSelect.value === 'zhibo8';
    const t = sourceSelect.value === 'txsp';
    document.getElementById('zhibo8-type-row').style.display = z ? '' : 'none';
    txspConfigRow.style.display = t ? '' : 'none';
    document.getElementById('folder-row').style.display = (z || t) ? 'none' : '';
    document.getElementById('video-file-row').style.display = (z || t) ? 'none' : '';
    if (z) bvidInput.placeholder = '输入比赛ID';
    else if (t) bvidInput.placeholder = '输入比赛ID（不用填）';
    else if (sourceSelect.value === 'iqiyi') bvidInput.placeholder = '输入 16 位 tvid';
    else bvidInput.placeholder = '输入 BV 号或 EP 号...';
    if (!z && !t) clearPollTimers();
  });

  playPauseBtn.addEventListener('click', () => {
    if (isRunning) pauseSimulation(); else startSimulation();
  });

  offsetSlider.addEventListener('input', () => applySetting('offset', Number(offsetSlider.value)));
  fontSizeSlider.addEventListener('input', () => applySetting('fontSize', Number(fontSizeSlider.value)));
  opacitySlider.addEventListener('input', () => applySetting('opacity', Number(opacitySlider.value)));
  speedSlider.addEventListener('input', () => applySetting('speed', Number(speedSlider.value)));
  areaSlider.addEventListener('input', () => applySetting('area', Number(areaSlider.value)));

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

  resetBtn.addEventListener('click', () => {
    engine.configure({ offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 });
    syncControls();
  });

  exitBtn.addEventListener('click', () => {
    clearPollTimers();
    pauseSimulation();
    engine.destroy();
    hidePanel();
  });

  // --- iPad 触摸 ---
  indicator.style.pointerEvents = 'auto';
  indicator.style.cursor = 'pointer';
  indicator.style.width = '18px';
  indicator.style.height = '18px';
  indicator.style.top = '50%';
  indicator.style.right = '12px';
  indicator.style.transform = 'translateY(-50%)';
  indicator.style.border = '2px solid rgba(255,107,138,0.5)';
  indicator.title = '点此唤出控制面板';

  indicator.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
  panel.addEventListener('click', () => { if (isPanelVisible()) resetHideTimer(); });

  // 关闭按钮
  const dragHandle = document.getElementById('panel-drag-handle');
  if (dragHandle) {
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.title = '隐藏面板';
    closeBtn.style.cssText = 'font-size:18px;cursor:pointer;color:#a0a8c0;padding:0 4px;line-height:1;';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); hidePanel(); });
    dragHandle.appendChild(closeBtn);
  }

  // 提示文字
  var hint = panel.querySelector('div[style*="font-size:10px"]');
  if (hint) {
    hint.textContent = '右上角红点唤出面板 · 点击✕关闭 · 20秒自动隐藏';
    hint.style.color = '#888';
  }

  // 脉冲动画
  var pulseStyle = document.createElement('style');
  pulseStyle.textContent = '@keyframes dotPulse { 0%,100%{opacity:0.15} 50%{opacity:0.6} }';
  document.head.appendChild(pulseStyle);

  // --- 多端同步（服务端持久化） ---
  const streamInput = document.getElementById('streamUrl');
  var saveTimer = null;
  var ipadSettings = {};

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      ipadSettings.streamUrl = streamInput ? streamInput.value.trim() : '';
      ipadSettings.matchId = bvidInput ? bvidInput.value.trim() : '';
      ipadSettings.txspRoomId = txspRoomId ? txspRoomId.value.trim() : '';
      ipadSettings.txspProgramId = txspProgramId ? txspProgramId.value.trim() : '';
      ipadSettings.txspCookie = txspCookie || '';
      ipadSettings.source = sourceSelect ? sourceSelect.value : '';
      ipadSettings.txspLastSeq = txspLastSeq;
      ipadSettings.txspCursor = txspCursor;
      fetch(SERVER + '/api/ipad-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ipadSettings)
      }).catch(() => {});
    }, 500);
  }

  async function loadSettings() {
    try {
      ipadSettings = await api(SERVER + '/api/ipad-settings') || {};
    } catch (e) { ipadSettings = {}; }

    if (ipadSettings.streamUrl && streamInput) streamInput.value = ipadSettings.streamUrl;
    if (ipadSettings.matchId && bvidInput) bvidInput.value = ipadSettings.matchId;
    if (ipadSettings.txspRoomId && txspRoomId) txspRoomId.value = ipadSettings.txspRoomId;
    if (ipadSettings.txspProgramId && txspProgramId) txspProgramId.value = ipadSettings.txspProgramId;
    if (ipadSettings.txspCookie) txspCookie = ipadSettings.txspCookie;
    if (ipadSettings.source && sourceSelect) sourceSelect.value = ipadSettings.source;
    if (ipadSettings.txspLastSeq) txspLastSeq = ipadSettings.txspLastSeq;
    if (ipadSettings.txspCursor) txspCursor = ipadSettings.txspCursor;
  }

  if (streamInput) streamInput.addEventListener('input', saveSettings);
  if (bvidInput) bvidInput.addEventListener('input', saveSettings);
  if (txspRoomId) txspRoomId.addEventListener('input', saveSettings);
  if (txspProgramId) txspProgramId.addEventListener('input', saveSettings);
  if (sourceSelect) sourceSelect.addEventListener('change', saveSettings);

  // 保存 cookie 到设置（每次粘贴提取后）
  var origLoadDanmaku = loadDanmaku;
  loadDanmaku = function(id) {
    ipadSettings.txspCookie = txspCookie;
    ipadSettings.txspLastSeq = txspLastSeq;
    ipadSettings.txspCursor = txspCursor;
    fetch(SERVER + '/api/ipad-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ipadSettings)
    }).catch(() => {});
    return origLoadDanmaku(id);
  };

  // --- Init ---
  syncControls();
  showPanel();
  document.getElementById('zhibo8-type-row').style.display = '';
  document.getElementById('folder-row').style.display = 'none';
  document.getElementById('video-file-row').style.display = 'none';

  (async () => {
    await loadSettings();
    if (sourceSelect) sourceSelect.dispatchEvent(new Event('change'));
    setStatus('就绪 — 输入比赛ID，点击加载弹幕（设置已同步）');
  })();

  console.log('iPad Danmaku Overlay ready');
})();
