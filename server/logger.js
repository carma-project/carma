// Minimal structured (JSON line) logger. Keeps stdout machine-parseable for log
// aggregation while adding levels and structured fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function makeLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...(fields || {}) };
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }
  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export { makeLogger };

let requestCounter = 0;
export function newRequestId() {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return Date.now().toString(36) + '-' + requestCounter.toString(36);
}
