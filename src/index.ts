#!/usr/bin/env node

import { getConfig } from './config';
import { createLogger, getLogger } from './utils/logger';
import { createDatabase } from './database';
import { ErgoNodeService } from './services/ergoNode';
import { TransactionService } from './services/transactionService';
import { StorageRentBot } from './services/storageRentBot';

// Global instances
let bot: StorageRentBot | null = null;
let logger: any = null;

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  if (logger) {
    logger.info(`Received ${signal}, shutting down gracefully...`, { component: 'main' });
  } else {
    console.log(`Received ${signal}, shutting down gracefully...`);
  }

  try {
    if (bot) {
      await bot.cleanup();
    }

    if (logger) {
      await logger.close();
    }

    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Setup process signal handlers
function setupSignalHandlers(): void {
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    if (logger) {
      logger.error('Uncaught exception', { component: 'main', error });
    } else {
      console.error('Uncaught exception:', error);
    }
    gracefulShutdown('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    if (logger) {
      logger.error('Unhandled promise rejection', { 
        component: 'main', 
        reason: reason as Error,
        promise: promise.toString()
      });
    } else {
      console.error('Unhandled promise rejection:', reason);
    }
    gracefulShutdown('unhandledRejection');
  });
}

// Display bot status
async function showStatus(): Promise<void> {
  try {
    const config = getConfig();
    logger = createLogger(config.logLevel, config.logDir);
    
    const database = createDatabase(config.databasePath);
    const metrics = await database.getBotMetrics();
    const botState = await database.getAllBotState();

    console.log('\n=== SR-bot Status ===\n');
    
    // Bot State
    console.log('Bot State:');
    for (const state of botState) {
      console.log(`  ${state.key}: ${state.value}`);
    }
    
    console.log('\nMetrics:');
    console.log(`  Total Boxes Scanned: ${metrics.totalBoxesScanned}`);
    console.log(`  Eligible Boxes Found: ${metrics.eligibleBoxesFound}`);
    console.log(`  Total Rent Collected: ${metrics.totalRentCollected.toString()} nanoergs (${(Number(metrics.totalRentCollected) / 1e9).toFixed(9)} ERG)`);
    console.log(`  Total Fees Paid: ${metrics.totalTransactionsFees.toString()} nanoergs (${(Number(metrics.totalTransactionsFees) / 1e9).toFixed(9)} ERG)`);
    console.log(`  Successful Transactions: ${metrics.successfulTransactions}`);
    console.log(`  Failed Transactions: ${metrics.failedTransactions}`);
    console.log(`  Last Scan Height: ${metrics.lastScanHeight}`);
    console.log(`  Last Scan Time: ${metrics.lastScanTime.toISOString()}`);
    console.log(`  Wallet Balance: ${metrics.walletBalance.toString()} nanoergs (${(Number(metrics.walletBalance) / 1e9).toFixed(9)} ERG)`);

    // Recent transactions
    const transactions = await database.getTransactions();
    if (transactions.length > 0) {
      console.log('\nRecent Transactions:');
      for (const tx of transactions.slice(0, 5)) {
        console.log(`  ${tx.txId} - ${tx.status} - ${tx.boxIds.length} boxes - ${(Number(tx.totalRentCollected) / 1e9).toFixed(9)} ERG`);
      }
    }

    await database.close();
    
  } catch (error) {
    console.error('Failed to get status:', error);
    process.exit(1);
  }
}

// Main function
async function main(): Promise<void> {
  try {
    // Setup signal handlers
    setupSignalHandlers();

    // Check for status command
    if (process.env.NODE_ENV === 'status') {
      await showStatus();
      return;
    }

    // Load configuration
    const config = getConfig();
    
    // Initialize logger
    logger = createLogger(config.logLevel, config.logDir);
    logger.info('Starting SR-bot', { 
      component: 'main',
      version: '1.0.0',
      nodeEnv: process.env.NODE_ENV,
      dryRun: config.dryRun
    });

    // Initialize database
    const database = createDatabase(config.databasePath);
    logger.info('Database initialized', { component: 'main' });

    // Initialize Ergo node service
    const ergoNode = new ErgoNodeService(config);
    logger.info('Ergo node service initialized', { component: 'main' });

    // Initialize transaction service
    const transactionService = new TransactionService(config);
    logger.info('Transaction service initialized', { component: 'main' });

    // Initialize storage rent bot
    bot = new StorageRentBot(config, ergoNode, transactionService, database, logger);
    
    // Initialize and start the bot
    await bot.initialize();
    await bot.start();

    // Keep the process running
    logger.info('SR-bot is running. Press Ctrl+C to stop.', { component: 'main' });

    // In dry-run mode, run once and exit
    if (config.dryRun || process.env.NODE_ENV === 'dry-run') {
      logger.info('Dry-run completed, exiting...', { component: 'main' });
      await gracefulShutdown('dry-run-complete');
    }

  } catch (error) {
    if (logger) {
      logger.error('Failed to start SR-bot', { component: 'main', error: error as Error });
    } else {
      console.error('Failed to start SR-bot:', error);
    }
    process.exit(1);
  }
}

// Handle different execution modes
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { StorageRentBot }; 