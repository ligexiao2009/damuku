# 弹幕外挂 (danmuku-video-player)

一套跨播放器通用弹幕悬浮系统。以 Electron 透明悬浮窗形式叠加在任意播放器上方，支持五种弹幕源，集成 IINA 播放器全自动联动。

## 特性

- **五弹幕源**：B站、腾讯视频、芒果TV、直播吧、腾讯体育
- **Electron 透明悬浮窗**：不限播放器，IINA / 浏览器 / PotPlayer 等任意播放器均可叠加
- **IINA 全自动联动**：打开视频自动切文件夹+选视频+识别弹幕源+加载弹幕，暂停/快进自动同步
- **iPad 触屏优化**：HLS 直播流 + 实时弹幕 + 触控面板 + PWA 主屏幕图标
- **实时直播弹幕**：直播吧（足球/NBA/其他）、腾讯体育（NBA），增量轮询
- **播放进度云同步**：跨设备共享进度，IINA ↔ 弹幕外挂无缝衔接
- **视频转码**：ffmpeg videotoolbox 硬件加速，MKV → MP4
- **批量重命名**：B站番剧自动匹配 EP 号

## 环境要求

- Node.js 18+
- macOS（Windows 可用但部分功能受限）
- FFmpeg（可选，用于视频转码）
- IINA Plus（可选，用于联动功能）

## 快速开始

```bash
# 安装依赖
npm install

# 配置视频目录和端口（编辑 .env）
cp .env.example .env

# 一键启动
./scripts/start_overlay.sh
```

启动后悬浮窗自动覆盖所有显示器。`Esc` 或 `Cmd+O` 打开控制面板。

## 配置 .env

```env
VIDEO_DIR=/Users/yourname/video        # 视频文件目录
DANMU_CACHE_DIR=/Users/yourname/video/danmu  # 弹幕缓存
PORT=5001                               # 服务端口
BILI_SESSDATA=your_sessdata_here        # B站 Cookie（可选）
LOG_LEVEL=info                          # 日志级别: silent/error/warn/info/debug
```

## 弹幕源速查

| 弹幕源 | 输入内容 | 场景 |
|--------|---------|------|
| B站 | BV号 / EP号 | 番剧、影视回放 |
| 腾讯视频 | VID | 腾讯视频回放 |
| 芒果TV | HHMMSS/videoId | 芒果综艺回放 |
| 直播吧 | 比赛ID + 类型 | 足球/NBA/其他 实时直播 |
| 腾讯体育 | Room ID + Program ID | NBA 实时直播 |

## IINA 联动配置

1. IINA Plus → 偏好设置 → 高级 → 额外 mpv 参数：

```
input-ipc-server=/tmp/iina-socket
```

2. 启动进度监控：

```bash
python3 scripts/iina-watcher.py
```

IINA 播放视频时，弹幕外挂自动切换文件夹、选中视频、加载弹幕、恢复进度。暂停/快进自动同步。

## iPad 使用

```bash
npm start
```

iPad Safari 访问 `http://<Mac IP>:5001/ipad.html`，添加到主屏幕获得全屏体验。

## 快捷键

| 键 | 功能 |
|----|------|
| `Cmd+Space` | 暂停/播放 |
| `Cmd+←/→` | 快退/快进 0.5s |
| `Cmd+Shift+←/→` | 快退/快进 2s |
| `Cmd+↑/↓` | 透明度 |
| `Cmd+Shift+↑/↓` | 字号 |
| `Esc` / `Cmd+O` | 面板显隐 |
| `Cmd+L` | 加载弹幕 |
| `Cmd+Q` | 退出 |

## 打包发布

```bash
npm run dist:mac    # macOS DMG
```

## 项目结构

```
├── server.js           # Express 后端
├── electron/           # Electron 主进程
├── services/           # 弹幕源 API 客户端
├── public/             # 前端页面
│   ├── overlay.html    # 桌面悬浮窗
│   ├── ipad.html       # iPad 直播页
│   └── js/             # 前端脚本
├── scripts/            # 辅助脚本 & 监控
└── doc/                # 文档
```

## 详细文档

[整体架构与技术实现原理](doc/整体架构与技术实现原理.md)
