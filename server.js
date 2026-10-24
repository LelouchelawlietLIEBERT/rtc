'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApplication } = require('./lib/app');
const { createLogger } = require('./lib/logger');

function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(
      'Ignoring .env: Node 20.12 or newer is required to load env files. Export the variables instead.',
    );
    return;
  }
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.error(`Could not load .env: ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  loadEnvFile();
  if (process.exitCode) return;

  let application;
  try {
    application = createApplication();
  } catch (error) {
    const logger = createLogger('error');
    logger.error('configuration error', { message: error.message });
    process.exitCode = 1;
    return;
  }

  const { logger, config } = application;

  try {
    const address = await application.start();
    logger.info('server started', {
      env: config.env,
      port: address.port,
      url: config.appUrl,
      maxParticipants: config.maxParticipants,
      turn: config.turnConfigured,
    });
    if (!config.turnConfigured) {
      logger.warn(
        'TURN is not configured. Calls may fail on restrictive networks; configure TURN_URLS for production.',
      );
    }
  } catch (error) {
    logger.error('failed to start server', { message: error.message });
    await application.stop().catch(() => {});
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('forced shutdown after timeout');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    try {
      application.io.emit('server:restarting', {
        message: 'The server is restarting. Reconnecting may take a moment.',
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await application.stop();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { message: error.message });
      clearTimeout(forceExit);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { message: error.message });
    shutdown('uncaughtException');
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
