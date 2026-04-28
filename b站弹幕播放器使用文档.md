# B站弹幕播放器使用文档

## 项目简介

这是一套基于 **Node.js + HTML5 + JavaScript** 的本地/局域网视频播放器系统，支持：

- 本地视频播放（Mac / Windows）
- 文件夹批量播放
- iPad / 手机局域网访问
- 自动匹配 B站 BV号 / EP号
- 在线加载 B站弹幕（XML / seg.so）
- 弹幕缓存
- 播放进度记忆
- 播放列表管理
- 全屏播放
- 多设备共享

---

# 一、环境要求

## 必装软件

### Node.js
建议版本：

- Node.js 18+

下载：

- https://nodejs.org/

---

## 依赖安装

在项目目录运行：

```bash
npm install express axios fast-xml-parser protobufjs dotenv cors
```

---

# 二、项目目录结构

推荐结构：

```bash
project/
├── server.js
├── .env
├── cache/
├── public/
│   └── video.html
└── videos/
    ├── EP01.mp4
    ├── EP02.mkv
    └── ...
```

---

# 三、配置说明

## `.env` 文件

```env
BILI_SESSDATA=你的B站SESSDATA（可选）
VIDEO_DIR=/你的视频目录路径（可选）
```

---

### BILI_SESSDATA 作用：

- 提高部分番剧弹幕访问成功率
- 大会员内容兼容更好
- 非必须

---

### VIDEO_DIR：

可指定项目外部视频目录，例如：

### macOS：

```env
VIDEO_DIR=/Users/yang/Movies/Bilibili
```

### Windows：

```env
VIDEO_DIR=D:\Videos\Bilibili
```

---

# 四、启动服务

```bash
node server.js
```

成功后：

```bash
本机访问：
http://localhost:3000/video.html

局域网访问：
http://你的Mac局域网IP:3000/video.html
```

例如：

```bash
http://192.168.0.120:3000/video.html
```

---

# 五、功能使用指南

# 1. 本地电脑播放

## 单文件：

点击：

```text
选择视频文件
```

---

## 文件夹：

点击：

```text
选择文件夹
```

系统将：

- 自动扫描所有视频
- 创建播放列表
- 支持上一集 / 下一集

---

# 2. iPad / 手机播放

## 前提：

- Mac 与 iPad 在同一 WiFi
- Node 服务保持运行

---

## 操作：

Safari 打开：

```text
http://Mac局域网IP:3000/video.html
```

---

## 点击：

```text
获取服务器视频
```

即可读取服务器目录下视频。

---

# 六、弹幕功能

## 输入支持：

### BV号：

```text
BV1CqizYmEWG
```

### EP号：

```text
ep473307
```

---

## 自动识别：

若视频文件名中包含：

- BV号
- ep号

例如：

```text
EP01_长安的荔枝_ep473314.mp4
```

播放器会自动加载对应弹幕。

---

## 获取策略：

### XML：

- 老接口
- 稳定
- 弹幕可能较少

### seg.so（推荐）：

- 新接口
- 弹幕更多
- 更完整
- 默认推荐

---

## 刷新弹幕：

可强制重新拉取并更新缓存。

---

# 七、播放设置

## 弹幕速度

调整弹幕滚动时间。

---

## 显示区域

控制弹幕占屏幕比例。

---

## 弹幕偏移

用于：

- 片头误差
- 本地剪辑版本同步
- 时间轴校正

---

# 八、播放记录

系统自动保存：

- 当前播放位置
- 每个视频独立记录

重新打开后自动续播。

---

# 九、支持格式

### 推荐：

- MP4（H.264）

### 可用：

- MKV
- MOV
- WEBM
- AVI

---

## 注意：

### iPad Safari 最佳兼容：

```text
MP4 + H.264 + AAC
```

---

## 不兼容时建议：

使用 FFmpeg 转码：

```bash
ffmpeg -i input.mkv -c:v libx264 -c:a aac output.mp4
```

---

# 十、常见问题排查

# 播放列表为空

检查：

- `/api/videos` 是否正常
- 视频目录路径是否正确
- 文件扩展名是否支持

---

# iPad打不开

检查：

- Node 是否运行
- IP 地址是否正确
- 防火墙是否阻止 3000 端口
- 是否同一局域网

---

# 视频无法播放

原因：

- 编码不支持
- Safari兼容问题

解决：

- 转码为 MP4 H.264

---

# 弹幕加载失败

检查：

- BV/EP 是否正确
- B站接口是否可访问
- SESSDATA 是否失效

---

# 十一、性能建议

## 推荐：

- 使用 MP4
- 使用 seg.so
- 开启缓存
- 使用有线网络（Mac）
- 局域网 WiFi 5GHz

---

# 十二、安全建议

建议加入：

- 路径校验
- 防目录穿越
- 外部目录权限控制

---

# 十三、进阶升级方向

可扩展：

- 自动刮削剧集信息
- 海报墙
- ASS字幕支持
- HLS转码
- NAS支持
- 多用户
- Jellyfin/Plex式界面

---

# 十四、技术架构

```text
本地视频文件
     ↓
Node.js 服务端
     ↓
/api/videos
/stream
/api/danmu
     ↓
浏览器 video 标签
     ↓
弹幕渲染层
```

---

# 十五、总结

这套播放器适合：

- 本地B站剧集收藏
- 韩剧字幕播放
- iPad远程看片
- 家庭影视库
- 私人局域网流媒体

---

## 核心优势：

- 免费
- 高自由度
- 支持弹幕
- 局域网共享
- 可持续扩展

---

如继续升级，可逐步发展为完整私人媒体服务器。
---
## 视频转换mkv-mp4
ffmpeg -i "初恋这件小事_ep236563.mkv" -c:v h264_videotoolbox -b:v 5000k -c:a aac -b:a 192k -movflags +faststart "初恋这件小事_ep236563_browser.mp4"