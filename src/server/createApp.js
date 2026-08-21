const express = require('express');
const path = require('path');
const { createRateLimiter } = require('../services/rateLimiter');

function isHttpsUrl(url) {
  return /^https:\/\//i.test(url);
}

function createApp({ bot, config, sendSearchResults, logger = console }) {
  const app = express();
  const apiLimiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_MAX,
    banDurationMs: config.BAN_DURATION_MS
  });

  app.use(express.json());

  if (isHttpsUrl(config.MINIAPP_URL)) {
    app.use(bot.webhookCallback(config.WEBHOOK_PATH));
  }

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.get('/health', (_, res) => {
    res.json({ ok: true });
  });

  app.post('/api/search', async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown')
        .toString()
        .split(',')[0]
        .trim();

      const verdict = apiLimiter.check(`ip:${ip}`);
      if (!verdict.allowed) {
        return res.status(429).json({ ok: false, error: 'Слишком много запросов. Попробуйте позже.' });
      }

      const { positions, position, city, employmentType, minExperienceYears, telegramUsername, chatId } = req.body || {};
      const numericChatId = Number(chatId);

      if (!Number.isFinite(numericChatId)) {
        return res.status(400).json({ ok: false, error: 'Некорректный chat_id.' });
      }

      await sendSearchResults(numericChatId, {
        positions,
        position,
        city,
        employmentType,
        minExperienceYears,
        telegramUsername
      });

      return res.json({ ok: true });
    } catch (error) {
      logger.error('Ошибка /api/search:', error);
      return res.status(500).json({ ok: false, error: 'Не удалось отправить результаты.' });
    }
  });

  return app;
}

module.exports = {
  createApp
};