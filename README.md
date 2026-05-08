# 弹幕外挂 (danmuku-video-player)

一套跨平台的视频追剧与弹幕聚合系统，支持桌面播放器、Electron 悬浮窗、iPad 触屏、首页视频库等场景。集成多弹幕源、IINA 联动、视频库管理、直播流嗅探等功能。

## 特性

- **六弹幕源**：B站、腾讯视频、芒果TV、直播吧、腾讯体育、爱奇艺
- **Electron 透明悬浮窗**：不限播放器，IINA / 浏览器 / PotPlayer 等任意播放器均可叠加
- **IINA 全自动联动**：打开视频自动切文件夹+选视频+识别弹幕源+加载弹幕，暂停/快进自动同步
- **iPad 触屏优化**：HLS 直播流 + 实时弹幕 + 触控面板 + PWA 主屏幕图标
- **实时直播弹幕**：直播吧、腾讯体育，增量轮询
- **视频库**：腾讯/爱奇艺/B站/Douban 元数据聚合，封面墙展示，分集详情，一键 IINA 播放
- **直播流嗅探**：Chrome CDP 自动抓取 m3u8 地址，支持 iframe 嵌套
- **腾讯体育 Cookie 提取**：自动从 v.qq.com 提取 roomId/programId/cookie
- **豆瓣评分查询**：支持 IMDb ID / 中文片名搜索
- **播放进度云同步**：跨设备共享进度
- **视频转码**：ffmpeg videotoolbox 硬件加速
- **批量重命名**：B站/爱奇艺/腾讯视频剧集自动匹配

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
# 服务器
PORT=5001                               # 服务端口，默认 3000
LOG_LEVEL=info                          # 日志级别: silent | error | warn | info | debug

# 路径
VIDEO_DIR=/Users/yourname/video         # 视频文件目录
DANMU_CACHE_DIR=/Users/yourname/video/danmu  # 弹幕缓存

# 认证
BILI_SESSDATA=your_sessdata_here        # B站 Cookie，用于请求弹幕和元信息

# 弹幕
DANMAKU_MAX_DURATION=10800              # 最大时长（秒），默认 3 小时

# 清理
PLAYBACK_MAX_AGE=30                     # 播放记录保留天数
```

支持命令行参数临时切换日志级别：

```bash
node server.js --debug    # 临时开启调试日志
node server.js --info     # 正常日志
node server.js --warn     # 仅警告
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
├── server.js              # Express 入口：中间件、清理任务、挂载路由
├── routes/                # API 路由（按功能域拆分）
│   ├── danmaku.js         #   弹幕获取（B站/腾讯/芒果/直播吧/腾讯体育/爱奇艺）
│   ├── video.js           #   视频流、缩略图、目录浏览
│   ├── library.js         #   文件夹扫描、批量重命名
│   ├── library_info.js    #   视频库扫描、元数据聚合、图片代理、IINA 播放
│   ├── progress.js        #   播放进度存取、IINA 状态同步
│   ├── convert.js         #   ffmpeg 转码任务
│   ├── manage.js          #   视频管理、保留策略、流嗅探
│   └── config.js          #   浮层弹幕配置、文件夹历史
├── shared/                # 路由共享模块
│   ├── constants.js       #   缓存目录等常量
│   └── helpers.js         #   公共函数（路径解析、目录扫描等）
├── services/              # 第三方 API 封装
│   ├── bilibili.js        #   B站
│   ├── tencent.js         #   腾讯视频弹幕
│   ├── tencent_detail.js  #   腾讯视频详情（演员/导演/分集/评分）
│   ├── aiqiyi.js          #   爱奇艺弹幕
│   ├── mango.js           #   芒果TV
│   ├── zhibo8.js          #   直播吧
│   └── txsp.js            #   腾讯体育
├── utils/                 # 工具函数（logger、file、video、response、db）
├── public/                # 前端页面
│   ├── index.html         #   首页（V-Box 入口）
│   ├── video.html         #   桌面播放器
│   ├── library.html       #   视频库（封面墙 + 详情）
│   ├── manage.html        #   视频管理（磁盘清理）
│   ├── rename.html        #   批量重命名
│   ├── stream.html        #   直播流播放 + Cookie 提取
│   ├── overlay.html       #   Electron 悬浮窗
│   ├── ipad.html          #   iPad 触屏版
│   └── js/                #   前端脚本（danmaku-core.js、overlay.js、ipad.js）
├── electron/              # Electron 主进程 & preload
├── scripts/               # CLI 工具
│   ├── stream-sniffer.js  #   Chrome CDP 流嗅探
│   ├── tencent_detail.py  #   腾讯视频详情查询
│   ├── aiqiyi.py          #   爱奇艺弹幕/重命名
│   └── iina-watcher.py    #   IINA 进度同步
└── doc/                   # 详细文档
```

## 详细文档

[整体架构与技术实现原理](doc/整体架构与技术实现原理.md)
