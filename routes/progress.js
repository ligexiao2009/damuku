const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { success, fail } = require('../utils/response');
const logger = require('../utils/logger');
const { PLAYBACK_DIR } = require('../shared/constants');
const { iinaState } = require('../shared/state');

const router = require('express').Router();

function safeFileName(id) {
  const s = String(id).replace(/\//g, '／');
  if (s.length <= 100) return s;
  return s.slice(0, 50) + '_' + crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
}

// POST /api/progress
router.post('/progress', (req, res) => {
  const { id, time } = req.body || {};
  if (!id) return res.status(400).json(fail(400, '缺少ID'));

  const safeId = safeFileName(id);
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);
  const saveTime = Number(time) || 0;
  fs.writeFileSync(file, JSON.stringify({ id, time: saveTime, updatedAt: Date.now() }, null, 2));

  logger.debug(`💾 [progress] 保存: ${id} → ${saveTime}s`);
  res.json(success(null));
});

// GET /api/progress
router.get('/progress', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json(fail(400, '缺少ID'));

  const safeId = safeFileName(id);
  const file = path.join(PLAYBACK_DIR, `${safeId}.json`);
  const legacyFile = path.join(PLAYBACK_DIR, `${encodeURIComponent(String(id))}.json`);
  const actualFile = fs.existsSync(file) ? file : (fs.existsSync(legacyFile) ? legacyFile : null);

  if (!actualFile) return res.json(success({ time: 0 }));

  try {
    res.json(success(JSON.parse(fs.readFileSync(actualFile, 'utf-8'))));
  } catch {
    res.json(success({ time: 0 }));
  }
});

// POST /api/iina-state
router.post('/iina-state', (req, res) => {
  const { paused, time, path: filePath } = req.body || {};
  if (typeof paused === 'boolean') iinaState.paused = paused;
  if (typeof time === 'number') iinaState.time = time;
  if (typeof filePath === 'string') iinaState.path = filePath;
  res.json(success(iinaState));
});

// GET /api/iina-state
router.get('/iina-state', (_req, res) => {
  res.json(success(iinaState));
});

module.exports = router;
