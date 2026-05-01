const path = require('path');

/** 根据文件扩展名返回 MIME 类型。 */
function getVideoMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    default: return 'application/octet-stream';
  }
}

/** 从文件名中提取 BV 号或 EP 号，未匹配返回 ''。 */
function detectVideoIdFromName(name) {
  if (!name) return '';
  const baseName = path.basename(name).replace(/\.[^.]+$/, '');
  const bvidMatch = baseName.match(/BV[0-9A-Za-z]+/i);
  if (bvidMatch) return bvidMatch[0];
  const explicitEpMatch = baseName.match(/(?:^|[_\s-])(ep\d{4,})(?=$|[_\s-])/i);
  if (explicitEpMatch) return explicitEpMatch[1];
  return '';
}

/** 去除文件名中的非法字符，空格替换为下划线。 */
function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

/** 从文件名匹配集数（支持 S01E02、EP01、第X集 格式），未匹配返回 null。 */
function extractEpisodeNumberFromFileName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const patterns = [
    /S\d+E(\d{1,3})/i,
    /(?:^|[\s._-])EP?(\d{1,3})(?=$|[\s._-])/i,
    /第\s*(\d{1,3})\s*[集话]/i
  ];

  for (const pattern of patterns) {
    const match = baseName.match(pattern);
    if (match) {
      const episodeNumber = Number.parseInt(match[1], 10);
      if (Number.isInteger(episodeNumber) && episodeNumber > 0) {
        return episodeNumber;
      }
    }
  }

  return null;
}

/** 从 B站链接或纯数字中提取 EP 号。 */
function extractEpId(input) {
  const str = String(input || '');
  const match = str.match(/ep(\d+)/i);
  if (match) return match[1];

  if (/^\d+$/.test(str.trim())) {
    return str.trim();
  }

  return null;
}

module.exports = {
  getVideoMimeType,
  detectVideoIdFromName,
  sanitizeFileName,
  extractEpisodeNumberFromFileName,
  extractEpId
};
