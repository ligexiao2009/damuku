const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ========= 配置 =========
const CHANNEL_ID = 'UCBKDRq35-L8xev4O7ZqBeLg';
const CHANNEL_NAME = '王局';

const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}/videos`;

const BASE_DIR = '/Users/yangyang/video/youtube';
const ARCHIVE_FILE = path.join(__dirname, 'downloaded.txt');
const THUMB_DIR = path.join(__dirname, '..', 'cache', 'thumbs');
const RETENTION_FILE = path.join(__dirname, '..', 'cache', 'retention_config.json');

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

// 下载封面到 cache/thumbs（与 getThumbPath 命名一致: xxx.mp4.jpg）
function downloadCover(videoId, title) {
  ensureDir(THUMB_DIR);
  const name = formatTitle(title);
  const file = path.join(THUMB_DIR, `${name}.mp4.jpg`);

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
    '--merge-output-format', 'mp4',
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
      // 追加可读记录
      const today = new Date();
      const ds = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      fs.appendFileSync(ARCHIVE_FILE, `# ${ds} ${name}\n`);
      setRetention(path.join(dir, `${name}.mp4`));
      downloadCover(videoId, title);
    } else {
      console.log('\n❌ 下载失败');
    }
  });
}

// 设置视频 7 天后自动删除
function setRetention(filePath) {
  try {
    let config = { folders: {}, files: {} };
    if (fs.existsSync(RETENTION_FILE)) {
      config = JSON.parse(fs.readFileSync(RETENTION_FILE, 'utf-8'));
    }
    if (!config.files) config.files = {};
    config.files[filePath] = { days: 7, setAt: Date.now() };
    fs.writeFileSync(RETENTION_FILE, JSON.stringify(config, null, 2));
    console.log('🗑️  已设置 7 天后自动删除:', path.basename(filePath));
  } catch (err) {
    console.log('⚠️ 设置保留策略失败:', err.message);
  }
}

// 读取已下载记录
function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) return new Set();
  const content = fs.readFileSync(ARCHIVE_FILE, 'utf-8');
  return new Set(content.trim().split('\n').map(l => l.replace('youtube ', '').trim()).filter(Boolean));
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
    '-f', 'mp4',
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
    const archive = loadArchive();

    for (const line of lines) {
      const [id, date, title] = line.split('|');

      const cleanTitle = title.replace(/\s/g, '');

      if (cleanTitle.includes(keyword)) {
        console.log('🎯 命中目标视频:', title);

        if (archive.has(id)) {
          const fname = formatTitle(title);
          const videoFile = path.join(saveDir, `${fname}.mp4`);
          const coverFile = path.join(THUMB_DIR, `${fname}.mp4.jpg`);
          if (fs.existsSync(videoFile) && fs.existsSync(coverFile)) {
            console.log('⏭️ 视频和封面已存在，跳过');
            return;
          }
          console.log('📋 已归档但文件缺失，重新下载');
        }

        downloadVideo(id, title, saveDir);
        return;
      }
    }

    console.log('⚠️ 没找到匹配视频');
  });
}

run();