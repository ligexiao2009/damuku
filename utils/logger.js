const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

const configuredLevel = String(process.env.LOG_LEVEL || process.env.DEBUG_LOG || 'info').toLowerCase();
const currentLevel = configuredLevel === '1' || configuredLevel === 'true'
  ? LEVELS.debug
  : (LEVELS[configuredLevel] ?? LEVELS.info);

const timers = new Map();

function enabled(level) {
  return currentLevel >= LEVELS[level];
}

function write(method, level, args) {
  if (!enabled(level)) return;
  console[method](...args);
}

function time(level, label) {
  if (!enabled(level)) return;
  timers.set(label, process.hrtime.bigint());
}

function timeEnd(level, label) {
  if (!enabled(level)) return;
  const start = timers.get(label);
  if (!start) return;
  timers.delete(label);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${label}: ${elapsedMs.toFixed(1)}ms`);
}

module.exports = {
  error: (...args) => write('error', 'error', args),
  warn: (...args) => write('warn', 'warn', args),
  info: (...args) => write('log', 'info', args),
  debug: (...args) => write('log', 'debug', args),
  timeDebug: label => time('debug', label),
  timeEndDebug: label => timeEnd('debug', label),
  isDebug: () => enabled('debug')
};
