const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const logDir = path.join(app.getPath('userData'), 'logs');
const logPath = path.join(logDir, 'app.log');
fs.mkdirSync(logDir, { recursive: true });

/** @param {string} level @param {string} message @param {unknown} [data] */
function write(level, message, data) {
  rotateIfNeeded();
  const suffix = data !== undefined ? ` ${safeStringify(data)}` : '';
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`;
  console.log(line);
  try { fs.appendFileSync(logPath, line + '\n'); } catch {}
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch {}
}

/** @param {unknown} data */
function safeStringify(data) {
  if (data instanceof Error) return JSON.stringify({ message: data.message, stack: data.stack });
  try { return JSON.stringify(data); } catch { return String(data); }
}

module.exports = {
  error: (message, data) => write('error', message, data),
  warn: (message, data) => write('warn', message, data),
  info: (message, data) => write('info', message, data),
  debug: (message, data) => write('debug', message, data),
  logPath,
};
