function getCandidateKey(candidate) {
  return candidate.resumeUrl || `${candidate.source}:${candidate.name}:${candidate.position}`;
}

function createCandidateSubscriptions({ bot, intervalMs, searchCandidates, logger = console }) {
  const subscriptions = new Map();

  function stop(chatId) {
    const key = String(chatId);
    const subscription = subscriptions.get(key);
    if (!subscription) return;

    clearInterval(subscription.intervalId);
    subscriptions.delete(key);
  }

  function stopAll() {
    for (const subscription of subscriptions.values()) {
      clearInterval(subscription.intervalId);
    }
    subscriptions.clear();
  }

  function start(chatId, payload, knownCandidates, sendCandidate) {
    const key = String(chatId);
    stop(key);

    const seenKeys = new Set((knownCandidates || []).map(getCandidateKey));
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
        const resultsPerQuery = await Promise.all(
          subscription.payload.queries.map((query) => searchCandidates({
            position: query.position,
            city: query.city,
            employmentType: subscription.payload.employmentType,
            minExperienceYears: subscription.payload.minExperienceYears
          }))
        );

        const freshCandidates = resultsPerQuery.flat().filter((candidate) => {
          const candidateKey = getCandidateKey(candidate);
          if (subscription.seenKeys.has(candidateKey)) return false;

          subscription.seenKeys.add(candidateKey);
          return true;
        });

        if (!freshCandidates.length) return;

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

    subscriptions.set(key, subscription);
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
    getQueries,
    removeQuery,
    getAll,
    has(chatId) {
      return subscriptions.has(String(chatId));
    }
  };
}

module.exports = {
  createCandidateSubscriptions
};
