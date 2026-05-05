// 腾讯体育直播页面 - 提取 room_id / program_id / cookie
// F12 Console 粘贴执行即可

(function () {
  var roomId = '';
  var programId = '';
  var cookie = document.cookie;

  function tryMatch(txt) {
    var rm = txt.match(/"room_?id"\s*[:=]\s*"?(\d+)"?/i)
          || txt.match(/room_?id['"]?\s*[:=]\s*(\d+)/i)
          || txt.match(/'room_?id'\s*[:=]\s*'?(\d+)'?/i);
    var pm = txt.match(/"program_?id"\s*[:=]\s*"?(\d+)"?/i)
          || txt.match(/program_?id['"]?\s*[:=]\s*['"]?(\d+)['"]?/i)
          || txt.match(/'program_?id'\s*[:=]\s*'?(\d+)'?/i);
    if (rm) roomId = roomId || rm[1];
    if (pm) programId = programId || pm[1];
    // NUXT 闭包参数: ..., {}, "room_id值", "program_id值", ...
    var nuxt = txt.match(/\{\}\s*,\s*"(\d{8,11})"\s*,\s*"(\d{5,8})"/);
    if (nuxt) { roomId = roomId || nuxt[1]; programId = programId || nuxt[2]; }
    // 页面内嵌 cookie 字符串
    var cm = txt.match(/"cookie"\s*:\s*"([^"]+)"/i);
    if (cm && cm[1].length > 50) cookie = cm[1];
  }

  // 1. 从页面全局变量找（含 camelCase 变体）
  var keys = Object.keys(window).filter(function (k) {
    return /room/i.test(k) || /program/i.test(k) || /match/i.test(k) || /live/i.test(k);
  });
  keys.forEach(function (k) {
    try {
      var v = window[k];
      if (typeof v === 'object' && v.room_id) roomId = v.room_id;
      if (typeof v === 'object' && v.program_id) programId = v.program_id;
      if (typeof v === 'object' && v.roomId) roomId = v.roomId;
      if (typeof v === 'object' && v.programId) programId = v.programId;
    } catch (e) {}
  });

  // 2. 从页面 script 内容正则匹配（含 JSON blob 解析）
  var scripts = document.querySelectorAll('script');
  scripts.forEach(function (s) {
    var txt = s.textContent || s.innerText || '';
    tryMatch(txt);
    // 尝试解析 JSON（如 __NUXT__、__INITIAL_STATE__ 等）
    if (!roomId || !programId) {
      try {
        var j = JSON.parse(txt);
        tryMatch(JSON.stringify(j));
      } catch (e) {}
    }
  });

  // 2.5 从 window.__NUXT__ 序列化提取（腾讯体育 SPA 状态树）
  if (window.__NUXT__) {
    try { tryMatch(JSON.stringify(window.__NUXT__)); } catch (e) {}
  }

  // 3. 从 URL 提取 program_id
  var urlMatch = location.href.match(/\/live\/p\/\w+\/(\d+)/i);
  if (urlMatch) programId = programId || urlMatch[1];

  // 4. 抓取 API 请求中的 body（XHR 拦截）
  if (!roomId || !programId) {
    var origSend = XMLHttpRequest.prototype.send;
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      this._u = u;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (!roomId || !programId) {
        try {
          var d = JSON.parse(body);
          if (d.room_id) roomId = d.room_id;
          if (d.program_id) programId = d.program_id;
          if (roomId && programId) {
            XMLHttpRequest.prototype.send = origSend;
            XMLHttpRequest.prototype.open = origOpen;
          }
        } catch (e) {}
      }
      return origSend.apply(this, [body]);
    };
    console.log('[等待] 下次 API 请求将自动提取 room_id/program_id，请切换比赛或刷新页面...');
  }

  var result = JSON.stringify({
    room_id: Number(roomId) || '',
    program_id: String(programId || ''),
    cookie: cookie
  }, null, 2);

  console.log('[提取结果]', result);

  // 复制到剪贴板
  var ta = document.createElement('textarea');
  ta.value = result;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);

  if (roomId && programId) {
    alert('已提取！\nroom_id: ' + roomId + '\nprogram_id: ' + programId + '\n\n已复制到剪贴板');
  } else {
    alert('cookie 已提取\nroom_id/program_id 等待 API 请求（请切换比赛或刷新页面）\n已复制到剪贴板');
  }
})();
