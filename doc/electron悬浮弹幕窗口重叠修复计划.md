# Electron 悬浮弹幕窗口重叠修复计划（Overlay真正覆盖播放器）

> 目标：将当前 Electron 独立窗口模式，修正为系统级透明全屏悬浮层，实现弹幕直接覆盖任意播放器画面。

---

# 一、当前问题分析（Problem Analysis）

## 当前现象
### 错误模式：
```txt
播放器窗口
+
Electron窗口（独立存在）
```

### 导致问题：
- 弹幕无法覆盖视频
- 控制面板独立显示
- 页面像第二播放器
- 用户体验差

---

# 正确目标模式（Target State）

```txt
播放器窗口（底层）
        ↓
Electron透明悬浮层（顶层）
        ↓
弹幕直接显示在视频上方
```

---

# 二、核心修改方向（Core Fixes）

# Phase 1：Electron主窗口配置修正

## 文件：
```txt
electron/main.js
```

---

## 必须修改参数：

```javascript
transparent: true,
frame: false,
fullscreen: true,
alwaysOnTop: true,
hasShadow: false,
resizable: false,
skipTaskbar: true
```

---

## 必须增加：
```javascript
mainWindow.setIgnoreMouseEvents(true)
```

### 作用：
- 点击穿透
- 不阻挡播放器操作

---

## Mac增强（必须）：
```javascript
mainWindow.setAlwaysOnTop(true, 'screen-saver')
mainWindow.setVisibleOnAllWorkspaces(true, {
  visibleOnFullScreen: true
})
```

### 作用：
- 保证全屏播放器上方显示
- 防止被系统层级压制

---

## 验收标准：
- Electron窗口覆盖播放器
- 全屏稳定
- 鼠标操作播放器正常

---

# Phase 2：Overlay页面透明化

## 文件：
```txt
public/overlay.html
public/css/overlay.css
```

---

## HTML要求：
### 页面仅保留：
- Canvas弹幕层
- 可隐藏控制面板

---

## CSS要求：
```css
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
  overflow: hidden;
}

canvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
```

---

## 必须确保：
- 无黑底
- 无网页背景
- 无边框
- 无播放器元素

---

# Phase 3：控制面板优化

## 当前问题：
- 面板遮挡视频
- 长期开启影响观感

---

## 修复方案：
### 默认隐藏：
```javascript
panel.style.display = 'none';
```

---

### 快捷键显示：
```javascript
O键切换控制面板
ESC隐藏控制面板
```

---

## 推荐：
- 半透明面板
- 可拖动
- 小型化

---

## 验收标准：
- 默认纯弹幕模式
- 面板按需显示

---

# Phase 4：Canvas全屏适配

## 要求：
- 自动适配分辨率
- 窗口resize监听
- Retina屏优化
- 多比例支持

---

## 推荐：
```javascript
canvas.width = window.innerWidth * devicePixelRatio;
canvas.height = window.innerHeight * devicePixelRatio;
```

---

## 验收标准：
- 弹幕位置正确
- 不拉伸
- 清晰显示

---

# Phase 5：播放器使用规范

## 用户需：
### 本地播放器必须全屏：
- 夸克播放器
- VLC
- IINA
- PotPlayer
- 浏览器播放器

---

## 原因：
Electron Overlay覆盖整个屏幕，而非嵌入播放器窗口。

---

# 三、推荐最终结构（Recommended Runtime Model）

```txt
用户打开本地播放器（全屏）
          ↓
播放视频
          ↓
启动 Electron Overlay
          ↓
加载弹幕
          ↓
透明层覆盖播放器
          ↓
快捷键微调同步
```

---

# 四、调试检查清单（Debug Checklist）

## 若仍无法覆盖：
### 检查：
- [ ] transparent 是否开启
- [ ] frame 是否关闭
- [ ] fullscreen 是否开启
- [ ] alwaysOnTop 是否开启
- [ ] setIgnoreMouseEvents 是否开启
- [ ] CSS背景是否透明
- [ ] Canvas是否全屏
- [ ] 控制面板是否隐藏
- [ ] Mac全屏工作区设置是否开启

---

# 五、优先修改顺序（Recommended Order）

| 优先级 | 修改项 |
|--------|--------|
| 高 | main.js窗口配置 |
| 高 | overlay页面透明化 |
| 高 | 点击穿透 |
| 中 | 控制面板隐藏 |
| 中 | Canvas自适应 |
| 低 | UI美化 |

---

# 六、后续优化方向（V2）

## 可扩展：
- 自动检测播放器窗口尺寸
- OCR同步
- 多屏支持
- AI字幕翻译
- 手机控制

---

# 七、最终交付目标（Deliverable）

## 成功标准：
### 用户体验：
- 任意播放器全屏播放
- Electron透明覆盖
- 弹幕直接悬浮视频上层
- 无额外窗口感
- 类似原生B站体验

---

# 一句话总结

**核心不是做第二个播放器窗口，而是将 Electron 改造成“全屏透明置顶点击穿透弹幕层”。**

