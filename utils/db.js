#!/usr/bin/env node
/**
 * 豆瓣评分查询（支持 IMDb ID 或中文片名）
 * 用法: node utils/db.js <imdb_id | 片名>
 * 示例: node utils/db.js tt0816692
 *       node utils/db.js 想见你
 */
const axios = require('axios');

async function searchDouban(query) {
  const res = await axios.get(
    `https://movie.douban.com/subject_search?search_text=${encodeURIComponent(query)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 10000,
    }
  );

  const match = res.data.match(/window\.__DATA__\s*=\s*({.*?});/);
  if (!match) throw new Error('未找到豆瓣数据');

  const data = JSON.parse(match[1]);
  const items = data.items || [];
  if (items.length === 0) throw new Error(`未找到 "${query}" 对应的豆瓣条目`);

  return items;
}

function printItem(item) {
  const rating = item.rating;
  console.log(`${item.title}`);
  console.log(`评分: ${rating.value}  (${rating.count ? rating.count.toLocaleString() + '人评价' : ''})`);
  console.log(`链接: ${item.url}`);
  if (item.abstract) console.log(`${item.abstract}`);
  if (item.abstract_2) console.log(`主创: ${item.abstract_2}`);
}

function printResults(items, query) {
  console.log(`搜索 "${query}" 共 ${items.length} 条结果:\n`);

  // 优先匹配完全一致的中文片名
  const exact = items.find(item => {
    const title = item.title || '';
    return title.includes(query);
  });
  const list = exact ? [exact, ...items.filter(i => i !== exact)] : items;

  for (let i = 0; i < Math.min(list.length, 5); i++) {
    if (i > 0) console.log('---');
    printItem(list[i]);
  }
}

const query = process.argv[2];

if (!query) {
  console.log('用法: node utils/db.js <imdb_id | 片名>');
  console.log('示例: node utils/db.js tt0816692');
  console.log('      node utils/db.js 想见你');
  process.exit(1);
}

searchDouban(query).then(items => {
  printResults(items, query);
}).catch(err => {
  console.error('请求失败:', err.message);
  process.exit(1);
});
