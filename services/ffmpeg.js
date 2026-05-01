const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getVideoMimeType } = require('../utils/video');

/** 以 HTTP 流方式直接传输视频文件，支持 Range 请求。 */
function streamDirect(videoPath, req, res) {
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let contentType = getVideoMimeType(videoPath);
  if (!contentType || contentType === 'application/octet-stream') {
    contentType = 'video/mp4';
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    const fileStream = fs.createReadStream(videoPath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(videoPath).pipe(res);
  }
}

/** 用 ffmpeg 实时转码视频为浏览器兼容的 H.264/AAC 格式并流式输出。 */
function transcodeStream(videoPath, req, res) {
  if (req.headers.range) {
    res.setHeader('Accept-Ranges', 'none');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache'
  });

  const ffmpegArgs = [
    '-hwaccel', 'videotoolbox',
    '-i', videoPath,
    '-c:v', 'h264_videotoolbox',
    '-b:v', '6000k',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', data => {
    const msg = data.toString();
    if (msg) console.log('[ffmpeg]', msg.trim());
  });

  ffmpeg.on('error', err => {
    console.error('FFmpeg 启动失败:', err);
    if (!res.headersSent) {
      res.status(500).send('FFmpeg 启动失败');
    } else {
      res.end();
    }
  });

  ffmpeg.on('close', () => {
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    try { ffmpeg.kill('SIGKILL'); } catch { }
  });
}

/** 用 ffmpeg 在视频第 5 秒处截取一帧作为缩略图。 */
async function generateLocalThumb(videoPath, thumbPath) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-ss', '00:00:05',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      thumbPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    ffmpeg.stderr.on('data', data => {
      const msg = data.toString();
      if (msg) console.log('[ffmpeg-thumb]', msg.trim());
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(thumbPath)) resolve();
      else reject(new Error(`缩略图生成失败，ffmpeg退出码 ${code}`));
    });
  });
}

module.exports = { streamDirect, transcodeStream, generateLocalThumb };
