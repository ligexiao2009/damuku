const path = require('path');
const os = require('os');

const BASE_DIR = process.env.CACHE_BASE || path.join(__dirname, '..');
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const PLAYBACK_DIR = path.join(BASE_DIR, 'playback');
const DANMU_DIR = process.env.DANMU_CACHE_DIR || path.join(CACHE_DIR, 'danmu');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_DIR = path.join(CACHE_DIR, 'meta');
const CONVERT_HISTORY_FILE = path.join(CACHE_DIR, 'convert_history.json');
const FOLDER_HISTORY_FILE = path.join(CACHE_DIR, 'folder_history.json');
const OVERLAY_CONFIG_FILE = path.join(CACHE_DIR, 'overlay_config.json');
const RETENTION_CONFIG_FILE = path.join(CACHE_DIR, 'retention_config.json');
const FOLDERS_BASE = process.env.FOLDERS_BASE || path.join(os.homedir(), 'video');
const PLAYBACK_MAX_AGE = (Number(process.env.PLAYBACK_MAX_AGE) || 30) * 86400000;

const IPAD_CONFIG_FILE = path.join(CACHE_DIR, 'ipad_settings.json');

const CACHE_DIRS = [CACHE_DIR, PLAYBACK_DIR, DANMU_DIR, THUMB_DIR, META_DIR];

module.exports = {
  BASE_DIR,
  CACHE_DIR,
  PLAYBACK_DIR,
  DANMU_DIR,
  THUMB_DIR,
  META_DIR,
  CONVERT_HISTORY_FILE,
  FOLDER_HISTORY_FILE,
  OVERLAY_CONFIG_FILE,
  RETENTION_CONFIG_FILE,
  FOLDERS_BASE,
  PLAYBACK_MAX_AGE,
  IPAD_CONFIG_FILE,
  CACHE_DIRS
};
