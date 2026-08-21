function getValue(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function getNumber(name, fallback) {
  const raw = getValue(name, '');
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig() {
  return {
    BOT_TOKEN: getValue('TELEGRAM_BOT_TOKEN'),
    MINIAPP_URL: getValue('MINIAPP_URL', 'http://localhost:3000'),
    PORT: getNumber('PORT', 3000),
    SEARCH_TIMEOUT_MS: getNumber('SEARCH_TIMEOUT_MS', 20000),
    RESUME_POLL_INTERVAL_MS: getNumber('RESUME_POLL_INTERVAL_MS', 3600000),
    RATE_LIMIT_WINDOW_MS: getNumber('RATE_LIMIT_WINDOW_MS', 60000),
    RATE_LIMIT_MAX: getNumber('RATE_LIMIT_MAX', 20),
    BAN_DURATION_MS: getNumber('BAN_DURATION_MS', 3600000),
    SEARCH_RESULTS_PER_SOURCE: getNumber('SEARCH_RESULTS_PER_SOURCE', 3),
    ADMIN_CHAT_ID: getValue('ADMIN_CHAT_ID', ''),
    WEBHOOK_PATH: '/telegram/webhook'
  };
}

module.exports = {
  loadConfig
};