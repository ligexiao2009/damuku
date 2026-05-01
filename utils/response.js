/** 构造统一成功响应 { code: 0, data, message: 'ok' } */
function success(data, message = 'ok') {
  return { code: 0, data, message };
}

/** 构造统一失败响应 { code, data: null, message } */
function fail(code, message) {
  return { code, data: null, message };
}

module.exports = { success, fail };
