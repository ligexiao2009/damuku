
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

app.use(express.static('public'));

async function fetchCid(bvid) {
    const url = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;

    const res = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    if (!res.data.data || !res.data.data[0]) {
        throw new Error('无效BV号');
    }

    return res.data.data[0].cid;
}



async function fetchDanmuXml(cid) {
    const url = `https://comment.bilibili.com/${cid}.xml`;
    const res = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    return res.data;
}

function parseDanmu(xml) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_'
    });

    const parsed = parser.parse(xml);
    let items = parsed?.i?.d || [];

    if (!Array.isArray(items)) {
        items = [items];
    }

    return items.map(item => {
        const p = item['@_p'].split(',');

        return {
            time: parseFloat(p[0]),
            mode: parseInt(p[1]),
            size: parseInt(p[2]),
            color: '#' + parseInt(p[3]).toString(16).padStart(6, '0'),
            text: item['#text'] || item['__text'] || ''
        };
    }).filter(d => d.text);
}

app.get('/api/danmu', async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({
        error: '缺少视频ID'
      });
    }

    let bvid = null;
    let epid = null;
    let cacheKey = '';
    let cid = null;

    // 自动判断类型
    if (id.toUpperCase().startsWith('BV')) {
      bvid = id.trim();
      cacheKey = bvid;
    } else {
      // 支持 ep1718519 或 1718519
      epid = id.replace(/^ep/i, '').trim();
      cacheKey = `ep${epid}`;
    }

    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);

    // 缓存命中
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(
        fs.readFileSync(cacheFile, 'utf-8')
      );

      return res.json(cached);
    }

    // 普通BV视频
    if (bvid) {
      cid = await fetchCid(bvid);
    }

    // 番剧 / 电影 / 纪录片
    if (epid) {
      const url = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`;

      const epRes = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      const episodes = epRes.data?.result?.episodes || [];

      const current = episodes.find(
        ep => String(ep.id) === String(epid)
      );

      if (!current) {
        throw new Error('无效EP号');
      }

      cid = current.cid;
    }

    if (!cid) {
      throw new Error('CID获取失败');
    }

    // 获取XML弹幕
    const xml = await fetchDanmuXml(cid);

    // 解析
    const danmus = parseDanmu(xml);

    const result = {
      source: bvid ? 'bvid' : 'epid',
      id,
      cid,
      count: danmus.length,
      danmus
    };

    // 写缓存
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(result)
    );

    res.json(result);

  } catch (err) {
    console.error('弹幕接口错误:', err);

    res.status(500).json({
      error: err.message || '服务器错误'
    });
  }
});


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});


