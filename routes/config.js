const fs = require('fs');
const { success, fail } = require('../utils/response');
const { OVERLAY_CONFIG_FILE, FOLDER_HISTORY_FILE } = require('../shared/constants');
const { resolveLibraryDirectory } = require('../shared/helpers');

const router = require('express').Router();

// GET /api/overlay-config
router.get('/overlay-config', (_req, res) => {
  try {
    const defaults = { offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 };
    const maxDuration = Number(process.env.DANMAKU_MAX_DURATION) || 10800;
    let config = defaults;
    if (fs.existsSync(OVERLAY_CONFIG_FILE)) {
      config = { ...defaults, ...JSON.parse(fs.readFileSync(OVERLAY_CONFIG_FILE, 'utf-8')) };
    }
    res.json(success({ ...config, maxDuration }));
  } catch {
    res.json(success({ offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25, maxDuration: 10800 }));
  }
});

// PUT /api/overlay-config
router.put('/overlay-config', (req, res) => {
  try {
    const defaults = { offset: 0, fontSize: 32, opacity: 1, speed: 18, area: 25 };
    const config = { ...defaults, ...req.body };
    fs.writeFileSync(OVERLAY_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json(success(config));
  } catch (err) {
    res.status(500).json(fail(500, err.message));
  }
});

// GET /api/folder-history
router.get('/folder-history', (_req, res) => {
  try {
    if (!fs.existsSync(FOLDER_HISTORY_FILE)) return res.json(success({}));
    res.json(success(JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8'))));
  } catch {
    res.json(success({}));
  }
});

// PUT /api/folder-history
router.put('/folder-history', (req, res) => {
  try {
    const { dir, name } = req.body;
    if (!dir || name == null) return res.status(400).json(fail(400, '缺少参数'));
    const safeDir = resolveLibraryDirectory(dir);
    let history = {};
    if (fs.existsSync(FOLDER_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(FOLDER_HISTORY_FILE, 'utf-8'));
    }
    history[safeDir] = name;
    fs.writeFileSync(FOLDER_HISTORY_FILE, JSON.stringify(history, null, 2));
    res.json(success(null));
  } catch (err) {
    res.status(400).json(fail(400, err.message));
  }
});

module.exports = router;
