// 腾讯体育直播页面 - 提取 room_id / program_id / cookie
// F12 Console 粘贴执行即可

(function () {
  var roomId = '';
  var programId = '';

  // 1. 从页面全局变量找
  var keys = Object.keys(window).filter(function (k) {
    return /room/i.test(k) || /program/i.test(k) || /match/i.test(k) || /live/i.test(k);
  });
  keys.forEach(function (k) {
    try {
      var v = window[k];
      if (typeof v === 'object' && v.room_id) roomId = v.room_id;
      if (typeof v === 'object' && v.program_id) programId = v.program_id;
    } catch (e) {}
  });

  // 2. 从页面 script 内容正则匹配
  var scripts = document.querySelectorAll('script');
  scripts.forEach(function (s) {
    var txt = s.textContent || s.innerText || '';
    var rm = txt.match(/"room_id"\s*[=:]\s*(\d+)/i) || txt.match(/room_id['"]?\s*[:=]\s*(\d+)/i);
    var pm = txt.match(/"program_id"\s*[=:]\s*['"]?(\d+)['"]?/i) || txt.match(/program_id['"]?\s*[:=]\s*['"]?(\d+)['"]?/i);
    if (rm) roomId = roomId || rm[1];
    if (pm) programId = programId || pm[1];
  });

  // 3. 抓取一次 API 请求中的 body
  if (!roomId || !programId) {
    var origSend = XMLHttpRequest.prototype.send;
    var self = this;
    XMLHttpRequest.prototype.send = function (body) {
      if (this._url && this._url.includes('zbpbaccess') && !roomId && !programId) {
        try {
          var d = JSON.parse(body);
          roomId = d.room_id || '';
          programId = d.program_id || '';
        } catch (e) {}
      }
      return origSend.apply(this, [body]);
    };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      this._url = u;
      return origOpen.apply(this, arguments);
    };
    console.log('[等待] 下次 API 请求将自动提取 room_id/program_id，请等待几秒或刷新页面...');
  }

  var result = JSON.stringify({
    room_id: Number(roomId) || '',
    program_id: String(programId || ''),
    cookie: document.cookie
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
    alert('cookie 已提取\nroom_id/program_id 等待 API 请求（请稍等或刷新页面）\n已复制到剪贴板');
  }
})();