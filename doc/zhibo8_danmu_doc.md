# 实时直播弹幕系统（Zhibo8 / Qiumibao）开发文档 v2.0

## 1. 项目概述
用于实时抓取直播吧（Zhibo8）弹幕数据，实现实时更新、分页拉取与去重输出。

---

## 2. 核心架构

count接口 -> num变化检测 -> page计算 -> v_page拉取 -> 去重输出

---

## 3. 核心接口

### count接口
https://dan.zhibo8.cc/data/2026/zuqiu/match{matchId}v_count.htm

返回：
{
  "num": "637",
  "per_page": 5
}

### page接口
https://dan.zhibo8.cc/data/2026/zuqiu/match{matchId}v_{page}.htm

---

## 4. 核心逻辑

page = ceil(num / per_page)-1

num变化 -> 触发请求page

---

## 5. 运行流程

1. 请求count
2. 判断num是否变化
3. 计算page
4. 请求page数据
5. 输出新弹幕（id去重）

---

## 6. 状态变量

- lastNum
- lastMaxId
- perPage

---



---

## 7. 总结

基于 num 驱动的实时弹幕采集系统。
