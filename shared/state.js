// 可变全局状态，跨路由模块共享
const path = require('path');

const state = {
  videoDir: process.env.VIDEO_DIR || path.join(__dirname, '..', 'videos'),
  danmuProgressMap: new Map(),
  convertTasks: new Map(),
  iinaState: { paused: false, time: 0, path: '' }
};

module.exports = state;
