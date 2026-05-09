# 弹幕播放器项目

## 加新功能清单

- UI: `public/xxx.html` — 管理页风格浅色主题（靛蓝 #6366f1，Inter 字体，白色卡片）
- 路由: `routes/xxx.js` — 响应格式 `{code:0,data,messages}` + `utils/response.js` 的 `success()`/`fail()`
- 注册: `server.js` 挂载 `app.use('/api', require('./routes/xxx'))`，静态页重定向
- 首页入口: `public/index.html` 卡片网格加一张

## 常用服务

- 腾讯详情: `services/tencent_detail.js` → `fetchTencentVideoDetail(cid)`
- 腾讯vid反查cid: `services/tencent_detail.js` → `fetchCidByVid(vid)`
- B站元数据: `services/bilibili.js` → `fetchVideoMeta(id, metaDir)`
- 豆瓣搜索: `routes/library_info.js` 内 `searchDouban(query)`
- 爱奇艺弹幕: `services/aiqiyi.js` → `fetchAiQiYiDanmaku(tvid)`
- 腾讯弹幕: `services/tencent.js` → `fetchTencentDanmaku(vid)`
- 图片代理: `/api/library/poster?url=` 绕过防盗链

## 常犯错误

- 改正则/常量前 grep 全项目搜所有引用，一次改完
- 测试时用 `PORT=5002` 别占 5001
- `tvid` 长度 9-16 位不能写死
- 腾讯合集页详情标题不可信，需 vid 页面标题 fallback
