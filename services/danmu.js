const protobuf = require('protobufjs');
const { XMLParser } = require('fast-xml-parser');

const DM_PROTO = `
syntax = "proto3";

message DanmakuElem {
  int64 id = 1;
  int32 progress = 2;
  int32 mode = 3;
  int32 fontsize = 4;
  uint32 color = 5;
  string midHash = 6;
  string content = 7;
  int64 ctime = 8;
  int32 weight = 9;
  string action = 10;
  int32 pool = 11;
  string idStr = 12;
  int32 attr = 13;
}

message DmSegMobileReply {
  repeated DanmakuElem elems = 1;
}
`;

const dmRoot = protobuf.parse(DM_PROTO).root;
const DmSegMobileReply = dmRoot.lookupType('DmSegMobileReply');

/** 解析 B站 XML 格式弹幕，返回标准化弹幕数组。 */
function parseDanmu(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  let items = parsed?.i?.d || [];
  if (!Array.isArray(items)) items = [items];

  return items.map(item => {
    const p = String(item['@_p'] || '').split(',');
    return {
      time: parseFloat(p[0] || '0'),
      mode: parseInt(p[1] || '1', 10),
      size: parseInt(p[2] || '25', 10),
      color: '#' + parseInt(p[3] || '16777215', 10).toString(16).padStart(6, '0'),
      ctime: parseInt(p[4] || '0', 10),
      text: item['#text'] || ''
    };
  }).filter(d => d.text);
}

/** 解析 B站 protobuf 格式弹幕分段，返回标准化弹幕数组。 */
function parseDanmuSeg(buffer) {
  const decoded = DmSegMobileReply.decode(buffer);
  return (decoded.elems || []).map(item => ({
    time: Number(item.progress || 0) / 1000,
    mode: Number(item.mode || 1),
    size: Number(item.fontsize || 25),
    color: '#' + Number(item.color || 16777215).toString(16).padStart(6, '0'),
    ctime: Number(item.ctime || 0),
    text: item.content || ''
  })).filter(d => d.text);
}

/** 安全解析弹幕分段，失败时记录日志并返回空数组。 */
function tryParseDanmuSeg(buffer, segmentIndex) {
  const str = Buffer.from(buffer).toString('utf-8', 0, Math.min(buffer.length, 200));
  if (str.startsWith('{')) {
    console.log(`[seg.so] 分段 ${segmentIndex} B站返回了JSON错误:`, str);
    return [];
  }
  try {
    return parseDanmuSeg(buffer);
  } catch (err) {
    console.log(`[seg.so] 分段 ${segmentIndex} protobuf 解析失败:`, err.message, `| 前200字节:`, str);
    return [];
  }
}

module.exports = { parseDanmu, parseDanmuSeg, tryParseDanmuSeg };
