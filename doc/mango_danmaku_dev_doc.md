# 📘 芒果（HiTV）弹幕系统开发文档（整库下载版）

## 1. 项目概述

本项目用于解析并下载芒果 TV（HiTV 系列）弹幕数据，实现弹幕数据的**批量获取与结构化存储**。

弹幕数据采用**按时间分片 JSON 存储**，通过顺序探测方式获取完整数据，无需预先知道视频时长或分片数量。

---

## 2. 弹幕接口结构

### 2.1 URL 格式

https://bullet-ws.hitv.com/bullet/tx/{YYYY}/{MM}/{DD}/{HHMMSS}/{videoId}/{segment}.json

---

### 2.2 参数说明

- YYYY/MM/DD：视频发布日期  
- HHMMSS：时间标识  
- videoId：视频唯一 ID  
- segment：分片索引（按分钟递增）

---

## 3. 分片机制

- 每个 JSON 文件约对应 60 秒视频内容  
- segment 从 0 开始递增  
- 分片可能存在缺失或空洞  

### 时间映射公式

segmentIndex = Math.floor(currentTimeMs / 60000)

---

## 4. 弹幕数据结构

### 正常数据
[
  {
    "time": 123.45,
    "content": "弹幕内容",
    "color": "#ffffff",
    "mode": "scroll"
  }
]

### 空分片
[]

### 分片不存在（NoSuchKey）
<Code>NoSuchKey</Code>

---

## 5. 核心设计原则

- 不依赖视频时长  
- 不依赖分片总数  
- 不做最大 index 预估  

---

## 6. 整库下载策略

segment = 0 → 请求 → 成功保存 → NoSuchKey累计 → 连续2次停止

---

## 7. 核心实现代码

async function downloadAll(baseUrl) {
  const result = [];
  let index = 0;
  let noKeyCount = 0;

  while (true) {
    const url = `${baseUrl}/${index}.json`;

    const res = await fetch(url);
    const text = await res.text();

    if (text.includes("NoSuchKey")) {
      noKeyCount++;
      if (noKeyCount >= 2) break;
      index++;
      continue;
    }

    noKeyCount = 0;

    try {
      const json = JSON.parse(text);
      result.push({ index, data: json });
    } catch {
      break;
    }

    index++;
  }

  return result;
}

---

## 8. 停止条件

- 连续 2 次 NoSuchKey

---

## 9. 不作为停止条件

- 空数组 []
- 单次 NoSuchKey
- HTTP 404

---

## 10. 输出结构

{
  videoId,
  segments: [
    { index, data }
  ]
}

---

## 11. 一句话总结

芒果弹幕系统 = 时间分片 + 顺序探测 + NoSuchKey 边界收敛
