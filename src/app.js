require('dotenv').config();

const { createBot } = require('./bot/createBot');
const { createApp } = require('./server/createApp');
const { loadConfig } = require('./config/env');
const { closeRobotaBrowser } = require('./services/search');

async function startTelegramTransport(bot) {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log('Telegram bot started in polling mode');
}

async function main() {
  const config = loadConfig();

  if (!config.BOT_TOKEN) {
    console.error('Не задан TELEGRAM_BOT_TOKEN в .env');
    process.exit(1);
  }

  const { bot, sendSearchResults, subscriptions } = createBot({ config, logger: console });
  const app = createApp({ bot, config, sendSearchResults, logger: console });

  const server = app.listen(config.PORT, async () => {
    console.log(`HTTP server started on port ${config.PORT}`);
    try {
      await startTelegramTransport(bot);
    } catch (error) {
      console.error('Ошибка запуска Telegram бота:', error);
      process.exitCode = 1;
    }
  });

  const shutdown = async () => {
    try {
      subscriptions.stopAll();
      await bot.stop();
    } catch (error) {
      console.error('Ошибка остановки Telegram бота:', error);
    } finally {
      await closeRobotaBrowser();
    }

    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});