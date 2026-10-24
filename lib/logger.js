'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, details) {
    if (LEVELS[levelName] < threshold) return;
    const suffix = details && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : '';
    const line = `${new Date().toISOString()} ${levelName.toUpperCase()} ${message}${suffix}`;
    if (levelName === 'error') {
      console.error(line);
    } else if (levelName === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
  };
}

module.exports = { createLogger };
