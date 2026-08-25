const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'subscriptions.json');

function getCandidateKey(candidate) {
  return candidate.resumeUrl || `${candidate.source}:${candidate.name}:${candidate.position}`;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('subscription tick timeout')), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createCandidateSubscriptions({ bot, intervalMs, searchCandidates, logger = console }) {
  const subscriptions = new Map();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const data = Array.from(subscriptions.values()).map((subscription) => ({
        chatId: subscription.chatId,
        telegramUsername: subscription.telegramUsername,
        payload: subscription.payload,
        seenKeys: Array.from(subscription.seenKeys)
      }));
      fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf8');
    } catch (error) {
      logger.error('Ошибка сохранения подписок на диск:', error);
    }
  }

  function createSubscription(chatId, payload, seenKeys, sendCandidate) {
    const subscription = {
      chatId,
      telegramUsername: payload.telegramUsername || '',
      payload: {
        queries: Array.isArray(payload.queries) && payload.queries.length ? payload.queries : [{ position: 'бухгалтер', city: '' }],
        employmentType: payload.employmentType || 'any',
        minExperienceYears: payload.minExperienceYears ?? null
      },
      seenKeys,
      isRunning: false,
      intervalId: null
    };

    subscription.intervalId = setInterval(async () => {
      if (subscription.isRunning) return;
      subscription.isRunning = true;

      try {
        const resultsPerQuery = await withTimeout(
          Promise.all(
            subscription.payload.queries.map((query) => searchCandidates({
              position: query.position,
              city: query.city,
              employmentType: subscription.payload.employmentType,
              minExperienceYears: subscription.payload.minExperienceYears
            }))
          ),
          5 * 60 * 1000
        );

        const freshCandidates = resultsPerQuery.flat().filter((candidate) => {
          const candidateKey = getCandidateKey(candidate);
          if (subscription.seenKeys.has(candidateKey)) return false;

          subscription.seenKeys.add(candidateKey);
          return true;
        });

        if (!freshCandidates.length) return;

        persist();

        await bot.telegram.sendMessage(chatId, 'Появились новые резюме по вашему запросу.');

        for (let i = 0; i < freshCandidates.length; i += 1) {
          await sendCandidate(chatId, freshCandidates[i], i);
        }
      } catch (error) {
        logger.error('Ошибка автообновления резюме:', error);
      } finally {
        subscription.isRunning = false;
      }
    }, intervalMs);

    return subscription;
  }

  function stop(chatId) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    clearInterval(subscription.intervalId);
    subscriptions.delete(key);
    persist();
  }

  function stopAll() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
    subscriptions.clear();
    persist();
  }

  // Останавливает таймеры при завершении процесса, но НЕ трогает файл на диске —
  // подписки должны пережить перезапуск/деплой, а не только "мягкую" остановку одним пользователем.
  function haltIntervals() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
  }

  function start(chatId, payload, knownCandidates, sendCandidate) {
    const key = String(chatId);
    stop(key);

    const seenKeys = new Set((knownCandidates || []).map(getCandidateKey));
    const subscription = createSubscription(chatId, payload, seenKeys, sendCandidate);
    subscriptions.set(key, subscription);
    persist();
  }

  function restore(sendCandidate) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {
      return;
    }

    if (!Array.isArray(saved)) return;

    for (const entry of saved) {
      if (!entry || !entry.chatId) continue;

      const key = String(entry.chatId);
      const seenKeys = new Set(entry.seenKeys || []);
      const payload = { ...entry.payload, telegramUsername: entry.telegramUsername };
      const subscription = createSubscription(entry.chatId, payload, seenKeys, sendCandidate);
      subscriptions.set(key, subscription);
    }
  }

  function getQueries(chatId) {
    const subscription = subscriptions.get(String(chatId));
    return subscription ? subscription.payload.queries : [];
  }

  function removeQuery(chatId, query) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    const remaining = subscription.payload.queries.filter(
      (item) => !(item.position === query.position && item.city === query.city)
    );

    if (!remaining.length) {
      stop(chatId);
      return;
    }

    subscription.payload.queries = remaining;
    persist();
  }

  function getAll() {
    return Array.from(subscriptions.values()).map((subscription) => ({
      chatId: subscription.chatId,
      telegramUsername: subscription.telegramUsername,
      queries: subscription.payload.queries
    }));
  }

  return {
    start,
    stop,
    stopAll,
    haltIntervals,
    getQueries,
    removeQuery,
    getAll,
    restore,
    has(chatId) {
      return subscriptions.has(String(chatId));
    }
  };
}

module.exports = {
  createCandidateSubscriptions
};
