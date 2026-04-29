# Electron 外挂弹幕系统开发计划（AI协作优化版）

> 目标：在现有 Node.js 本地网页播放器项目基础上，扩展 Electron 桌面外挂模式，实现跨播放器通用的 B站弹幕悬浮系统。

---

# 一、项目目标（Project Goal）

## 核心能力
- 任意本地播放器外挂（夸克 / VLC / IINA / PotPlayer / 浏览器）
- B站弹幕加载（XML / JSON / ASS）
- 系统级透明悬浮弹幕层
- 手动同步机制
- 快捷键控制
- 全屏覆盖
- 跨平台支持（macOS / Windows）

---

# 二、开发原则（Architecture Principles）

## 保留现有能力
### 不重写：
- Node 后端
- 视频接口
- 弹幕抓取逻辑
- 文件管理
- FFmpeg能力

---

## 新增能力
### 扩展：
- overlay.html
- Electron 壳
- 全局快捷键
- 透明悬浮层

---

# 三、推荐项目结构（Project Structure）

```txt
project/
├── server.js                    # Node主服务
├── routes/                      # API接口
│   ├── video.js
│   ├── danmaku.js
│   └── overlay-config.js
│
├── public/
│   ├── video.html               # 原网页播放器
│   ├── overlay.html             # 悬浮弹幕模式
│   │
│   ├── js/
│   │   ├── danmaku-core.js      # 核心弹幕引擎（共用）
│   │   ├── player.js            # 网页播放器逻辑
│   │   └── overlay.js           # 悬浮模式逻辑
│   │
│   └── css/
│       ├── player.css
│       └── overlay.css
│
├── electron/
│   ├── main.js                  # Electron主进程
│   └── preload.js               # 安全桥接
│
└── package.json
```

---

# 四、分阶段开发计划（Implementation Phases）

# Phase 1：Node接口标准化

## 目标
统一网页模式与桌面模式的数据来源。

## 必做任务
- 保留 `/api/video`
- 保留 `/api/danmaku`
- 保留 `/api/subtitle`
- 可选 `/api/thumbnail`
- 新增 `/api/overlay-config`

## 输出结果
```json
{
  "offset": 0,
  "fontSize": 32,
  "opacity": 1,
  "speed": 1
}
```

## 验收标准
- 所有模式均能读取统一配置
- 配置支持本地保存

---

# Phase 2：弹幕核心模块抽离

## 文件
```txt
public/js/danmaku-core.js
```

## 功能职责
- XML解析
- JSON解析
- ASS支持（可后续）
- 时间轴管理
- 弹幕队列
- Canvas渲染
- 偏移控制
- 字体/透明度控制

## 原则
### 单一职责：
只负责弹幕逻辑，不绑定具体页面。

## 验收标准
- video.html可调用
- overlay.html可调用

---

# Phase 3：Overlay前端页面开发

## 文件
```txt
public/overlay.html
public/js/overlay.js
```

## 页面要求
### UI层：
- 全透明背景
- Canvas弹幕层
- 控制面板
- 可隐藏

### 功能层：
- 开始/暂停
- 加载弹幕
- 时间偏移 ±
- 字体大小调整
- 透明度调整
- ESC退出

## 验收标准
- 浏览器中可独立运行
- 弹幕正常显示
- 偏移可调

---

# Phase 4：Electron封装

## 安装
```bash
npm install electron
```

## 文件
```txt
electron/main.js
electron/preload.js
```

---

## 主窗口配置
```js
transparent: true,
frame: false,
alwaysOnTop: true,
fullscreen: true,
skipTaskbar: true,
resizable: false
```

---

## 点击穿透
```js
mainWindow.setIgnoreMouseEvents(true)
```

## 验收标准
- 覆盖任意播放器
- 不阻挡鼠标
- 全屏稳定

---

# Phase 5：快捷键系统

## 推荐键位
| 按键 | 功能 |
|------|------|
| Space | 开始/暂停 |
| ← / → | 微调 ±0.5秒 |
| Shift+← / → | 大调 ±2秒 |
| ↑ / ↓ | 透明度 |
| Ctrl+滚轮 | 字体大小 |
| O | 控制面板 |
| ESC | 退出 |

## 实现方式
```js
globalShortcut.register()
```

## 验收标准
- 全局可用
- 无明显冲突

---

# Phase 6：打包发布

## 工具
```bash
npm install electron-builder --save-dev
```

## 输出
- macOS `.dmg`
- Windows `.exe`

## 验收标准
- 独立安装运行
- 用户无需开发环境

---

# 五、用户工作流（User Flow）

```txt
打开任意播放器
      ↓
播放本地视频
      ↓
启动 Electron Overlay
      ↓
加载B站弹幕
      ↓
手动同步开始点
      ↓
快捷键微调
      ↓
完成外挂弹幕体验
```

---

# 六、后续升级方向（V2+）

## 自动同步
- OCR时间识别
- 播放器窗口检测
- API同步（MPV/VLC/IINA）

## AI增强
- 韩剧字幕翻译
- 双语字幕
- 弹幕过滤
- 智能推荐

## 多端控制
- 手机遥控
- iPad控制台
- 局域网同步

---

# 七、风险点（Risks）

| 风险 | 解决方案 |
|------|----------|
| 全屏兼容问题 | Electron窗口调优 |
| 不同播放器尺寸差异 | 手动位置调整 |
| 性能问题 | Canvas优化 |
| 时间漂移 | 快捷键校准 |
| 多显示器适配 | 后续V2支持 |

---

# 八、开发时间预估（Timeline）

| 阶段 | 时间 |
|------|------|
| Node接口整理 | 0.5天 |
| 弹幕核心抽离 | 0.5天 |
| Overlay页面 | 1天 |
| Electron封装 | 0.5天 |
| 快捷键系统 | 0.5天 |
| 打包测试 | 0.5天 |

---

# 总周期
## 预计：2~3天

---

# 九、最终成果（Deliverables）

## 输出产品
### 网页模式：
- 本地网页播放器
- iPad访问
- 局域网共享

### 桌面模式：
- 任意播放器外挂弹幕
- 系统级透明悬浮层
- B站体验

---

# 十、适合AI协作的开发建议（For Other AI Tools）

## 建议拆分任务时按模块请求：
### 示例：
- “生成 danmaku-core.js 完整代码”
- “生成 overlay.html + overlay.js”
- “生成 Electron main.js 配置”
- “生成 globalShortcut 快捷键模块”
- “优化 Canvas 弹幕性能”

---

# 一句话总结

**保留现有 Node 项目 → 抽离弹幕核心 → 新增 Overlay 页面 → Electron透明封装 → 打造跨播放器通用 B站弹幕外挂系统。**