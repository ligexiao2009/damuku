const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { success, fail } = require('../utils/response');
const logger = require('../utils/logger');
const { CONVERT_HISTORY_FILE } = require('../shared/constants');
const { convertTasks } = require('../shared/state');
const { resolveLibraryVideoFile, isPathValidationError, saveConvertHistory } = require('../shared/helpers');

const router = require('express').Router();

// POST /api/convert
router.post('/convert', (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json(fail(400, '缺少 filePath 参数'));
    }
    const resolvedPath = resolveLibraryVideoFile(filePath);

    const dir = path.dirname(resolvedPath);
    const ext = path.extname(resolvedPath);
    const base = path.basename(resolvedPath, ext);
    const outputPath = path.join(dir, `${base}_browser.mp4`);

    const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = { id: taskId, input: resolvedPath, output: outputPath, status: 'probing', progress: 0, duration: 0, startTime: Date.now() };
    convertTasks.set(taskId, task);
    saveConvertHistory(task);

    const probe = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', resolvedPath
    ]);
    let probeOutput = '';
    probe.stdout.on('data', d => probeOutput += d.toString());
    probe.on('close', (code) => {
      if (code === 0) task.duration = Math.round(parseFloat(probeOutput.trim()) || 0);
      task.status = 'running';
      startFfmpeg(task);
    });
    probe.on('error', () => {
      task.status = 'running';
      startFfmpeg(task);
    });

    function startFfmpeg(task) {
      const args = [
        '-i', task.input,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'h264_videotoolbox',
        '-b:v', '5000k',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        '-y',
        task.output
      ];

      logger.info(`[convert] 开始转换: ${task.input} -> ${task.output}`);

      const ffmpeg = spawn('ffmpeg', args);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

      let lastProgress = '';
      ffmpeg.stdout.on('data', (data) => {
        lastProgress += data.toString();
        const timeMatch = lastProgress.match(/out_time_us=(\d+)/);
        if (timeMatch) {
          lastProgress = '';
          task.progress = Math.floor(Number(timeMatch[1]) / 1000000);
        }
      });

      ffmpeg.on('close', (code) => {
        task.endTime = Date.now();
        if (code === 0) {
          task.status = 'done';
          logger.info(`[convert] 完成: ${task.output}`);
        } else {
          task.status = 'error';
          task.error = stderr.slice(-500);
          logger.error(`[convert] 失败: ${stderr.slice(-300)}`);
        }
        saveConvertHistory(task);
      });

      ffmpeg.on('error', (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = Date.now();
        saveConvertHistory(task);
        logger.error(`[convert] ffmpeg 启动失败:`, err.message);
      });
    }

    res.json(success({ taskId, output: outputPath, duration: task.duration }));
  } catch (err) {
    const status = isPathValidationError(err) ? 400 : 500;
    if (status === 500) logger.error(err);
    res.status(status).json(fail(status, err.message || '转换失败'));
  }
});

// GET /api/convert/status
router.get('/convert/status', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少任务ID'));
  const task = convertTasks.get(id);
  if (!task) {
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
      const found = history.find(t => t.id === id);
      if (found) return res.json(success(found));
    }
    return res.status(404).json(fail(404, '任务不存在'));
  }
  res.json(success(task));
});

// GET /api/convert/history
router.get('/convert/history', (_req, res) => {
  try {
    const running = [];
    for (const t of convertTasks.values()) {
      if (t.status === 'running' || t.status === 'probing') running.push(t);
    }
    let history = [];
    if (fs.existsSync(CONVERT_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONVERT_HISTORY_FILE, 'utf-8'));
    }
    res.json(success([...running, ...history].slice(0, 20)));
  } catch {
    res.json(success([]));
  }
});

module.exports = router;
