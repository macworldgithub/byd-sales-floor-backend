/**
 * logger.js – Structured Logger for BYD Sales CRM Layer & Delivery Centre
 * Provides ISO timestamps, severity levels, contextual metadata, and JSON output in production.
 */

const isProduction = process.env.NODE_ENV === 'production';

function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  if (isProduction) {
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...meta,
    });
  }
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

const logger = {
  info: (msg, meta = {}) => {
    console.log(formatLog('info', msg, meta));
  },
  warn: (msg, meta = {}) => {
    console.warn(formatLog('warn', msg, meta));
  },
  error: (msg, meta = {}) => {
    console.error(formatLog('error', msg, meta));
  },
  debug: (msg, meta = {}) => {
    if (process.env.DEBUG || !isProduction) {
      console.debug(formatLog('debug', msg, meta));
    }
  },
};

module.exports = logger;
