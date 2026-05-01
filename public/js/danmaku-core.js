/**
 * DanmakuCore — reusable danmaku rendering engine.
 * Works with any container element. Uses Web Animations API for smooth scrolling.
 */
class DanmakuEngine {
  constructor(container, options = {}) {
    this.container = container;
    this.danmus = [];
    this.danmuIndex = 0;

    // Configuration
    this.speed = options.speed ?? 18;       // seconds to cross the screen
    this.area = options.area ?? 25;         // display area percentage (0-100)
    this.offset = options.offset ?? 0;      // time offset in seconds
    this.fontSize = options.fontSize ?? 24; // font size in px
    this.opacity = options.opacity ?? 1;    // global opacity
    this.showTimestamps = options.showTimestamps ?? false;

    // Internal state
    this._pool = [];
    this._active = [];       // active danmaku: {el, startX, endX, y, startMs, durationMs}
    this._laneAvailableAt = [];
    this._laneGap = 24;
    this._loopId = 0;
    this._maxPerFrame = 6;
    this._lastVideoTime = 0;
    this._lastPerfTime = 0;
    this._width = 0;
    this._height = 0;
    this._running = false;
    this._paused = false;

    // Measure canvas (shared, offscreen)
    this._measureCanvas = document.createElement('canvas');
    this._measureCtx = this._measureCanvas.getContext('2d');
    this._widthCache = new Map();

    this._onUpdate = options.onUpdate || null;

    this._updateSize();
    this._setupObserver();
  }

  _setupObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => this._updateSize());
    this._resizeObserver.observe(this.container);
  }

  _updateSize() {
    this._width = this.container.clientWidth || window.innerWidth;
    this._height = this.container.clientHeight || window.innerHeight;
  }

  // --- Configuration ---

  configure(updates) {
    let changed = false;
    if ('speed' in updates) { this.speed = updates.speed; changed = true; }
    if ('area' in updates) { this.area = updates.area; changed = true; }
    if ('offset' in updates) { this.offset = updates.offset; changed = true; }
    if ('fontSize' in updates) { this.fontSize = updates.fontSize; changed = true; }
    if ('opacity' in updates) { this.opacity = updates.opacity; changed = true; }
    if ('showTimestamps' in updates) { this.showTimestamps = updates.showTimestamps; changed = true; }
    if (changed) {
      this._laneAvailableAt = [];
      this._widthCache.clear();
    }
  }

  getConfig() {
    return {
      speed: this.speed,
      area: this.area,
      offset: this.offset,
      fontSize: this.fontSize,
      opacity: this.opacity,
      showTimestamps: this.showTimestamps
    };
  }

  _formatDanmuTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _formatSendTime(ctime) {
    if (!ctime || ctime <= 0) return '';
    const d = new Date(ctime * 1000);
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const YY = String(d.getFullYear()).slice(-2);
    return `${YY}-${MM}-${DD} ${HH}:${mm}`;
  }

  // --- Data loading ---

  load(danmus) {
    this.danmus = [...danmus].sort((a, b) => a.time - b.time);
    this.danmuIndex = 0;
    this._clear();
  }

  append(danmus) {
    if (!danmus.length) return;
    this.danmus = [...this.danmus, ...danmus].sort((a, b) => a.time - b.time);
  }

  reset() {
    this.danmuIndex = 0;
    this._clear();
  }

  seek(time) {
    const target = time + this.offset;
    this.danmuIndex = this.danmus.findIndex(d => d.time >= target);
    if (this.danmuIndex === -1) this.danmuIndex = this.danmus.length;
    this._clear();
    this._lastVideoTime = time;
    this._lastPerfTime = performance.now();
  }

  // --- Lifecycle ---

  start(currentTime) {
    this._running = true;
    this._paused = false;
    this._lastVideoTime = currentTime;
    this._lastPerfTime = performance.now();
    this._loop();
  }

  pause() {
    this._paused = true;
    this._stopLoop();
  }

  resume(currentTime) {
    if (!this._running) return;
    this._paused = false;
    this._lastVideoTime = currentTime;
    this._lastPerfTime = performance.now();
    this._loop();
  }

  destroy() {
    this._stopLoop();
    this._clear();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  // --- Internal rendering ---

  _measureWidth(text, fontSize) {
    const key = `${fontSize}:${text}`;
    if (this._widthCache.has(key)) return this._widthCache.get(key);
    this._measureCtx.font = `bold ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    const w = Math.ceil(this._measureCtx.measureText(text).width);
    this._widthCache.set(key, w);
    return w;
  }

  _getDom() {
    if (this._pool.length > 0) return this._pool.pop();
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transform = 'translate3d(-9999px, -9999px, 0)';
    el.style.whiteSpace = 'nowrap';
    el.style.fontWeight = 'bold';
    el.style.textShadow = '1px 1px 2px black, 0 0 2px black';
    el.style.backfaceVisibility = 'hidden';
    el.style.willChange = 'transform';
    el.style.contain = 'layout style paint';
    el.style.pointerEvents = 'none';
    this.container.appendChild(el);
    return el;
  }

  _clear() {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
    this._pool.length = 0;
    this._active.length = 0;
    this._laneAvailableAt = [];
  }

  _sendDanmu(danmu) {
    if (!this._width || !this._height) return false;

    const fontSize = this.fontSize;
    const text = this.showTimestamps
      ? `[${this._formatDanmuTime(danmu.time)}${danmu.ctime ? ' | ' + this._formatSendTime(danmu.ctime) : ''}] ${danmu.text}`
      : danmu.text;
    const danmuWidth = this._measureWidth(text, fontSize);

    const areaRatio = this.area / 100;
    const availableHeight = Math.max(fontSize, this._height * areaRatio);
    const laneHeight = fontSize + 8;
    const laneCount = Math.max(1, Math.floor(availableHeight / laneHeight));

    if (this._laneAvailableAt.length !== laneCount) {
      this._laneAvailableAt = Array(laneCount).fill(0);
    }

    const now = performance.now();
    let laneIndex = 0;
    let earliestTime = this._laneAvailableAt[0] || 0;
    let foundFree = false;

    for (let i = 0; i < this._laneAvailableAt.length; i++) {
      if ((this._laneAvailableAt[i] || 0) <= now) {
        laneIndex = i;
        foundFree = true;
        break;
      }
      if ((this._laneAvailableAt[i] || 0) < earliestTime) {
        earliestTime = this._laneAvailableAt[i];
        laneIndex = i;
      }
    }

    if (!foundFree && (this._laneAvailableAt[laneIndex] || 0) > now) return false;

    const el = this._getDom();
    el.textContent = text;
    el.style.color = danmu.color || '#ffffff';
    el.style.fontSize = `${fontSize}px`;
    el.style.opacity = this.opacity;

    const y = laneIndex * laneHeight;
    const durationMs = this.speed * 1000;
    const travelDistance = this._width + danmuWidth;
    const speedPxPerSecond = travelDistance / this.speed;
    const waitSeconds = (danmuWidth + this._laneGap) / speedPxPerSecond;
    this._laneAvailableAt[laneIndex] = now + waitSeconds * 1000;

    // Manual animation via rAF — more reliable than el.animate() in transparent Electron windows
    this._active.push({
      el,
      startX: this._width,
      endX: -danmuWidth,
      y,
      startMs: now,
      durationMs
    });

    return true;
  }

  _tickActive(now) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const a = this._active[i];
      const elapsed = now - a.startMs;
      if (elapsed >= a.durationMs) {
        // Finished — return to pool
        this._pool.push(a.el);
        this._active.splice(i, 1);
      } else {
        const progress = elapsed / a.durationMs;
        const x = a.startX + (a.endX - a.startX) * progress;
        a.el.style.transform = `translate3d(${x}px, ${a.y}px, 0)`;
      }
    }
  }

  _flush(currentTime) {
    let emitted = 0;
    const triggerTime = currentTime + this.offset;

    while (this.danmuIndex < this.danmus.length && this.danmus[this.danmuIndex].time <= triggerTime) {
      if (emitted >= this._maxPerFrame) {
        this.danmuIndex++;
        continue;
      }
      if (this._sendDanmu(this.danmus[this.danmuIndex])) emitted++;
      this.danmuIndex++;
    }
  }

  _stopLoop() {
    if (this._loopId) {
      cancelAnimationFrame(this._loopId);
      this._loopId = 0;
    }
  }

  _loop() {
    if (!this._running || this._paused) return;

    const tick = (now) => {
      if (!this._running || this._paused) {
        this._loopId = 0;
        return;
      }

      this._tickActive(now);

      let interpolatedTime = this._lastVideoTime;
      if (this._lastVideoTime !== this._lastVideoTime) {
        this._lastVideoTime = 0;
        this._lastPerfTime = now;
      } else {
        interpolatedTime = this._lastVideoTime + (now - this._lastPerfTime) / 1000;
      }

      this._flush(interpolatedTime);
      if (this._onUpdate) this._onUpdate(interpolatedTime);

      this._loopId = requestAnimationFrame(tick);
    };

    this._loopId = requestAnimationFrame(tick);
  }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DanmakuEngine;
}
