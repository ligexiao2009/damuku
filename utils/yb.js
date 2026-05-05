const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ========= 配置 =========
const CHANNEL_ID = 'UCBKDRq35-L8xev4O7ZqBeLg';
const CHANNEL_NAME = '王局';

const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}/videos`;

const BASE_DIR = '/Users/yangyang/video/youtube';
const ARCHIVE_FILE = path.join(__dirname, 'downloaded.txt');

const BROWSER = 'chrome';
const PROXY = 'http://127.0.0.1:7897'; // 👉 你的代理
// ========================

// 获取关键词
function getKeyword() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `王局拍案 ${y}${m}${day}`;
}

// 标题格式化
function formatTitle(title) {
  const dateMatch = title.match(/\d{8}$/);
  const date = dateMatch ? dateMatch[0] : '';

  let t = title.replace(/\d{8}$/, '');
  t = t.split('｜')[0];
  t = t.replace(/[！!]+$/, '');
  t = t.replace(/[\\/:*?"<>|]/g, '');
  t = t.replace(/[，, ]+$/, '');

  return t + date;
}

// 创建目录
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 下载封面（带进度）
function downloadCover(videoId, title, dir) {
  const name = formatTitle(title);
  const file = path.join(dir, `${name}.jpg`);

  const url = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  console.log('🖼️ 开始下载封面...');

  const curl = spawn('curl', [
    '-x', PROXY,
    '-L',
    '-A', 'Mozilla/5.0',
    url,
    '-o',
    file
  ]);

  curl.stderr.on('data', (data) => {
    process.stdout.write(data); // curl 进度
  });

  curl.on('close', (code) => {
    if (code === 0) {
      console.log('\n🖼️ 封面下载完成:', file);
    } else {
      console.log('\n❌ 封面下载失败');
    }
  });
}

// 下载视频（带进度）
function downloadVideo(videoId, title, dir) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const name = formatTitle(title);

  console.log('🎬 开始下载:', name);

  const args = [
    '--cookies-from-browser', BROWSER,
    '--proxy', PROXY,
    '--download-archive', ARCHIVE_FILE,
    '-o', `${dir}/${name}.%(ext)s`,
    url
  ];

  const yt = spawn('yt-dlp', args);

  yt.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  yt.stderr.on('data', (data) => {
    process.stdout.write(data);
  });

  yt.on('close', (code) => {
    if (code === 0) {
      console.log('\n✅ 下载完成:', name);
      downloadCover(videoId, title, dir);
    } else {
      console.log('\n❌ 下载失败');
    }
  });
}

// 主流程
function run() {
  const saveDir = path.join(BASE_DIR, CHANNEL_NAME);
  ensureDir(saveDir);

  const keyword = getKeyword().replace(/\s/g, '');
  console.log('🔍 匹配关键词:', keyword);

  const args = [
    '--cookies-from-browser', BROWSER,
    '--proxy', PROXY,
    '-f', 'mp4',   // 👈 就加在这里
    '--print', '%(id)s|%(upload_date)s|%(title)s',
    '--playlist-end', '10',
    CHANNEL_URL
  ];

  const yt = spawn('yt-dlp', args);

  let output = '';

  yt.stdout.on('data', (data) => {
    output += data.toString();
  });

  yt.on('close', () => {
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const [id, date, title] = line.split('|');

      const cleanTitle = title.replace(/\s/g, '');

      if (cleanTitle.includes(keyword)) {
        console.log('🎯 命中目标视频:', title);

        downloadVideo(id, title, saveDir);
        return;
      }
    }

    console.log('⚠️ 没找到匹配视频');
  });
}

run();