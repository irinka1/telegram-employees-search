const { Telegraf } = require('telegraf');
const { createRateLimiter } = require('../services/rateLimiter');
const { searchCandidates } = require('../services/search');
const { createCandidateSubscriptions } = require('./subscriptions');

function isHttpsUrl(url) {
  return /^https:\/\//i.test(url);
}

function appendChatId(url, chatId) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('chat_id', String(chatId));
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}chat_id=${encodeURIComponent(String(chatId))}`;
  }
}

async function safeReply(ctx, text, extra) {
  try {
    await ctx.reply(text, extra);
  } catch (error) {
    console.error('Ошибка отправки ответа в чат:', error);
  }
}

function formatEmployment(value) {
  if (!value) return 'любой';
  if (value === 'full-time') return 'полная занятость';
  if (value === 'part-time') return 'неполная занятость';
  if (value === 'remote') return 'удалённая работа';
  return value;
}

const NEW_SEARCH_LABEL = '🔎 Новий пошук';
const LIST_LABEL = '📋 Перелік резюме, які вже в пошуку';
const STOP_LABEL = '🛑 Зупини пошук';
const CANCEL_LABEL = '↩️ Скасувати';
const ADMIN_LIST_LABEL = '👥 Список посад у пошуку (усі)';

function queryLabel(query) {
  return `${query.position} — ${query.city || 'будь-яке місто'}`;
}

function isAdminChat(chatId, config) {
  return Boolean(config.ADMIN_CHAT_ID) && String(chatId) === String(config.ADMIN_CHAT_ID);
}

function createBot({ config, logger = console }) {
  const bot = new Telegraf(config.BOT_TOKEN);
  const limiter = createRateLimiter({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_MAX,
    banDurationMs: config.BAN_DURATION_MS
  });

  const subscriptions = createCandidateSubscriptions({
    bot,
    intervalMs: config.RESUME_POLL_INTERVAL_MS,
    searchCandidates,
    logger
  });

  const pendingStopSelection = new Map();

  function buildMenuKeyboard(chatId) {
    const rows = [
      [NEW_SEARCH_LABEL],
      [LIST_LABEL],
      [STOP_LABEL]
    ];

    if (isAdminChat(chatId, config)) {
      rows.push([ADMIN_LIST_LABEL]);
    }

    return {
      reply_markup: {
        keyboard: rows,
        resize_keyboard: true,
        is_persistent: true
      }
    };
  }

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await next();
      return;
    }

    const verdict = limiter.check(`chat:${chatId}`);
    if (!verdict.allowed) {
      if (verdict.banned) {
        await safeReply(ctx, 'Вы временно заблокированы за частые запросы. Попробуйте позже.');
      }
      return;
    }

    await next();
  });

  function getMiniappUrl() {
    return config.MINIAPP_URL;
  }

  function startButton(chatId) {
    const miniappUrl = getMiniappUrl();

    if (isHttpsUrl(miniappUrl)) {
      return {
        text: 'Старт',
        web_app: { url: miniappUrl }
      };
    }

    return {
      text: 'Старт',
      url: appendChatId(miniappUrl, chatId)
    };
  }

  async function sendStartMessage(ctx, text) {
    const miniappUrl = getMiniappUrl();

    if (isHttpsUrl(miniappUrl)) {
      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [[startButton(ctx.chat.id)]]
        }
      });
    } else {
      const fallbackUrl = appendChatId(miniappUrl, ctx.chat.id);
      await ctx.reply(
        `${text}\n\n` +
        `Сейчас у вас локальный URL, поэтому Telegram не может показать кнопку.\n` +
        `Откройте ссылку вручную:\n${fallbackUrl}\n\n` +
        `Если открываете с телефона, localhost не будет работать. Нужен публичный HTTPS URL.`
      );
    }

    await ctx.reply('Меню:', buildMenuKeyboard(ctx.chat.id));
  }

  async function sendCandidate(chatId, candidate, index) {
    const caption = [
      `${index + 1}. ${candidate.name}`,
      `Возраст: ${candidate.age || 'не указан'}`,
      `Должность: ${candidate.position || 'не указана'}`,
      `Опыт на должности: ${candidate.experienceYears !== null && candidate.experienceYears !== undefined ? `${candidate.experienceYears} лет` : 'не указан'}`,
      `Город: ${candidate.city || 'не указан'}`,
      `Резюме: ${candidate.resumeUrl}`,
      `Источник: ${candidate.source || 'не указан'}`
    ].join('\n');

    try {
      await bot.telegram.sendPhoto(chatId, candidate.photo, {
        caption
      });
    } catch {
      await bot.telegram.sendMessage(chatId, [caption, `Фото: ${candidate.photo}`].join('\n'));
    }
  }

  function normalizePositions(payload) {
    const rawPositions = Array.isArray(payload.positions) && payload.positions.length
      ? payload.positions
      : [{ position: payload.position, city: payload.city }];

    return rawPositions
      .map((item) => ({
        position: (item.position || '').toString().trim() || 'бухгалтер',
        city: (item.city || '').toString().trim()
      }))
      .filter((item, index, all) => all.findIndex((other) => other.position === item.position && other.city === item.city) === index);
  }

  function uniqueCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = candidate.resumeUrl || `${candidate.source}:${candidate.name}:${candidate.position}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function sendSearchResults(chatId, payload) {
    const positions = normalizePositions(payload);
    const employmentType = payload.employmentType || 'any';
    const minExperienceYearsRaw = payload.minExperienceYears;
    const minExperienceYears = minExperienceYearsRaw === '' || minExperienceYearsRaw === null || minExperienceYearsRaw === undefined
      ? null
      : Number(minExperienceYearsRaw);
    const normalizedMinExperience = Number.isFinite(minExperienceYears) && minExperienceYears >= 0 ? minExperienceYears : null;

    await bot.telegram.sendMessage(chatId, 'Ищу кандидатов, это займет до минуты...');

    const resultsPerQuery = await Promise.all(positions.map((query) => searchCandidates({
      position: query.position,
      city: query.city,
      employmentType,
      minExperienceYears: normalizedMinExperience,
      timeoutMs: config.SEARCH_TIMEOUT_MS,
      limit: config.SEARCH_RESULTS_PER_SOURCE
    })));

    const candidates = uniqueCandidates(resultsPerQuery.flat());

    subscriptions.start(chatId, {
      queries: positions,
      employmentType,
      minExperienceYears: normalizedMinExperience,
      telegramUsername: payload.telegramUsername || ''
    }, candidates, sendCandidate);

    if (config.ADMIN_CHAT_ID) {
      const requester = payload.telegramUsername ? `@${payload.telegramUsername}` : `chat_id ${chatId}`;
      const positionsList = positions.map((q) => `- ${queryLabel(q)}`).join('\n');

      bot.telegram.sendMessage(
        config.ADMIN_CHAT_ID,
        `Новый поиск от ${requester}:\n${positionsList}`
      ).catch((error) => {
        logger.error('Ошибка отправки уведомления администратору:', error);
      });
    }

    const queriesSummary = positions.map((q) => `${q.position}${q.city ? ` (${q.city})` : ''}`).join(', ');
    const pollMinutes = Math.max(1, Math.round(config.RESUME_POLL_INTERVAL_MS / 60000));

    if (!candidates.length) {
      await bot.telegram.sendMessage(
        chatId,
        `По запросу "${queriesSummary}" ничего не найдено. Попробуйте другое название должности или город.`
      );

      await bot.telegram.sendMessage(
        chatId,
        `Я продолжу проверять новые резюме каждые ${pollMinutes} мин. и пришлю их, если они появятся.`
      );
      return;
    }

    await bot.telegram.sendMessage(chatId, [
      'Найденные кандидаты:',
      `Запрос: ${queriesSummary}`,
      `Минимальный опыт: ${normalizedMinExperience !== null ? `${normalizedMinExperience} лет` : 'не задан'}`
    ].join('\n'));

    for (let i = 0; i < candidates.length; i += 1) {
      await sendCandidate(chatId, candidates[i], i);
    }

    await bot.telegram.sendMessage(
      chatId,
      `Автообновление включено. Я буду проверять новые резюме каждые ${pollMinutes} мин. Остановить можно командой /stop_updates.`
    );
  }

  bot.start(async (ctx) => {
    const text = isHttpsUrl(getMiniappUrl())
      ? 'Открой миниапп и заполни параметры поиска сотрудников:'
      : 'Открой форму по кнопке Старт. Для localhost откроется безопасный режим через ссылку:';

    await sendStartMessage(ctx, text);
  });

  bot.command('find', async (ctx) => {
    await sendStartMessage(ctx, 'Нажми Старт и заполни форму.');
  });

  bot.command('stop_updates', async (ctx) => {
    if (!subscriptions.has(ctx.chat.id)) {
      await ctx.reply('Для этого чата сейчас нет активного отслеживания резюме.');
      return;
    }

    subscriptions.stop(ctx.chat.id);
    await ctx.reply('Автообновление резюме остановлено.');
  });

  bot.hears(NEW_SEARCH_LABEL, async (ctx) => {
    subscriptions.stop(ctx.chat.id);
    pendingStopSelection.delete(ctx.chat.id);

    const text = isHttpsUrl(getMiniappUrl())
      ? 'Открой миниапп и заполни параметры поиска сотрудников:'
      : 'Открой форму по кнопке Старт. Для localhost откроется безопасный режим через ссылку:';

    await sendStartMessage(ctx, text);
  });

  bot.hears(LIST_LABEL, async (ctx) => {
    const queries = subscriptions.getQueries(ctx.chat.id);

    if (!queries.length) {
      await ctx.reply('Сейчас нет активных поисков.');
      return;
    }

    const list = queries.map((query, index) => `${index + 1}. ${queryLabel(query)}`).join('\n');
    await ctx.reply(`Сейчас отслеживаются:\n${list}`);
  });

  bot.hears(STOP_LABEL, async (ctx) => {
    const queries = subscriptions.getQueries(ctx.chat.id);

    if (!queries.length) {
      await ctx.reply('Сейчас нет активных поисков, нечего останавливать.');
      return;
    }

    pendingStopSelection.set(ctx.chat.id, queries);

    await ctx.reply('Выберите, поиск по какой должности остановить:', {
      reply_markup: {
        keyboard: [...queries.map((query) => [queryLabel(query)]), [CANCEL_LABEL]],
        resize_keyboard: true,
        is_persistent: true
      }
    });
  });

  bot.hears(ADMIN_LIST_LABEL, async (ctx) => {
    if (!isAdminChat(ctx.chat.id, config)) return;

    const active = subscriptions.getAll();
    const rows = active.flatMap((subscription) => {
      const requester = subscription.telegramUsername ? `@${subscription.telegramUsername}` : `chat_id ${subscription.chatId}`;
      return subscription.queries.map((query) => `${queryLabel(query)} — ${requester}`);
    });

    if (!rows.length) {
      await ctx.reply('Сейчас нет активных поисков ни у одного пользователя.');
      return;
    }

    const list = rows.map((row, index) => `${index + 1}. ${row}`).join('\n');
    await ctx.reply(`Активні пошуки (усі користувачі):\n${list}`);
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const pending = pendingStopSelection.get(chatId);
    if (!pending) return;

    const text = ctx.message.text;

    if (text === CANCEL_LABEL) {
      pendingStopSelection.delete(chatId);
      await ctx.reply('Отменено.', buildMenuKeyboard(chatId));
      return;
    }

    const match = pending.find((query) => queryLabel(query) === text);
    if (!match) return;

    subscriptions.removeQuery(chatId, match);
    pendingStopSelection.delete(chatId);
    await ctx.reply(`Остановлен поиск: ${queryLabel(match)}`, buildMenuKeyboard(chatId));
  });

  bot.on('message', async (ctx) => {
    const rawData = ctx.message?.web_app_data?.data;
    if (!rawData) return;

    try {
      const payload = JSON.parse(rawData);
      await sendSearchResults(ctx.chat.id, payload);
      await safeReply(ctx, 'Готово. Я отправил результаты в этот чат.');
    } catch (error) {
      logger.error('Ошибка обработки WebApp данных:', error);
      await safeReply(ctx, 'Не удалось обработать запрос. Попробуйте еще раз.');
    }
  });

  bot.catch((error) => {
    logger.error('Ошибка Telegraf:', error);
  });

  return {
    bot,
    sendSearchResults,
    subscriptions
  };
}

module.exports = {
  createBot
};