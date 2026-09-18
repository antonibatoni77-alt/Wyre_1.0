// Simple rotating file logger for the Wyre desktop shell.
const fs = require('node:fs');
const path = require('node:path');

let logDir = null;
const MAX_FILES = 7;

function init(userDataPath) {
  logDir = path.join(userDataPath, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  rotate();
}

function rotate() {
  try {
    const files = fs.readdirSync(logDir).filter((name) => /^wyre-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
    for (const file of files.slice(0, Math.max(0, files.length - MAX_FILES + 1))) {
      fs.rmSync(path.join(logDir, file), { force: true });
    }
  } catch {
    // Rotation is best-effort only.
  }
}

function fileName() {
  return `wyre-${new Date().toISOString().slice(0, 10)}.log`;
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map((item) => (item instanceof Error ? `${item.message}\n${item.stack}` : String(item))).join(' ')}\n`;
  if (logDir) {
    try {
      fs.appendFileSync(path.join(logDir, fileName()), line);
    } catch {
      // The file logger must never break the app.
    }
  }
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  consoleFn(line.trim());
}

module.exports = {
  init,
  dir: () => logDir,
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};
