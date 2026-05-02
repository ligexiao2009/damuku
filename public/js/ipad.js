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
    hideTimer = setTimeout(hidePanel, 8000);
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
  function clearZhibo8Poll() {
    if (zhibo8Timer) { clearInterval(zhibo8Timer); zhibo8Timer = null; }
  }

  async function loadDanmaku(id) {
    if (!id) { setStatus('请输入比赛ID'); return; }
    clearZhibo8Poll();
    zhibo8LastMaxId = 0;

    const type = zhibo8TypeSelect.value;
    setStatus('开始轮询直播吧弹幕...');

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

  // 一键粘贴直播地址
  var pasteBtn = document.getElementById('paste-stream-btn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          var input = document.getElementById('streamUrl');
          if (input) input.value = text.trim();
        }
      } catch {
        setStatus('无法读取剪贴板，请手动粘贴');
      }
    });
  }

  sourceSelect.addEventListener('change', () => {
    const z = sourceSelect.value === 'zhibo8';
    document.getElementById('zhibo8-type-row').style.display = z ? '' : 'none';
    document.getElementById('folder-row').style.display = z ? 'none' : '';
    document.getElementById('video-file-row').style.display = z ? 'none' : '';
    bvidInput.placeholder = z ? '输入比赛ID' : '输入 BV 号或 EP 号...';
    if (!z) clearZhibo8Poll();
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
    clearZhibo8Poll();
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
    hint.textContent = '右上角红点唤出面板 · 点击✕关闭 · 8秒自动隐藏';
    hint.style.color = '#888';
  }

  // 脉冲动画
  var pulseStyle = document.createElement('style');
  pulseStyle.textContent = '@keyframes dotPulse { 0%,100%{opacity:0.15} 50%{opacity:0.6} }';
  document.head.appendChild(pulseStyle);

  // --- 本地持久化 ---
  const streamInput = document.getElementById('streamUrl');
  const STREAM_KEY = 'ipad_stream_url';
  const MATCH_KEY = 'ipad_match_id';

  if (streamInput) {
    const saved = localStorage.getItem(STREAM_KEY);
    if (saved) streamInput.value = saved;
    streamInput.addEventListener('change', () => localStorage.setItem(STREAM_KEY, streamInput.value.trim()));
  }
  if (bvidInput) {
    const saved = localStorage.getItem(MATCH_KEY);
    if (saved) bvidInput.value = saved;
    bvidInput.addEventListener('change', () => localStorage.setItem(MATCH_KEY, bvidInput.value.trim()));
  }

  var liveLoadBtn = document.getElementById('live-load-btn');
  if (liveLoadBtn && streamInput) {
    var origClick = liveLoadBtn.onclick;
    liveLoadBtn.onclick = function(e) {
      localStorage.setItem(STREAM_KEY, streamInput.value.trim());
      if (origClick) origClick.call(this, e);
    };
  }

  var origLoadClick = loadBtn.onclick;
  loadBtn.onclick = function(e) {
    localStorage.setItem(MATCH_KEY, bvidInput.value.trim());
    if (origLoadClick) origLoadClick.call(this, e);
  };

  // --- Init ---
  syncControls();
  showPanel();
  document.getElementById('zhibo8-type-row').style.display = '';
  document.getElementById('folder-row').style.display = 'none';
  document.getElementById('video-file-row').style.display = 'none';
  setStatus('就绪 — 输入比赛ID，点击加载弹幕');

  console.log('iPad Danmaku Overlay ready');
})();
