// IMPORTANT: fake-indexeddb must be imported first to polyfill IndexedDB for Node.js
import 'fake-indexeddb/auto';

import { GossipBot } from './bot.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  Gossip AI Bot');
  console.log('='.repeat(50));

  // Load configuration
  const config = loadConfig();

  // Create and start bot
  const bot = new GossipBot(config);

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Main] Received ${signal}, shutting down...`);
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', error => {
    console.error('[Main] Uncaught exception:', error);
    bot.stop().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', reason => {
    console.error('[Main] Unhandled rejection:', reason);
  });

  // Start the bot
  try {
    await bot.start();
  } catch (error) {
    console.error('[Main] Failed to start bot:', error);
    process.exit(1);
  }
}

main();
