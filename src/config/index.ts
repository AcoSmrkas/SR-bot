import dotenv from 'dotenv';
import { Config } from '../types';

// Load environment variables
dotenv.config();

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue?: number): number {
  const value = process.env[name];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }
  return parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

export function loadConfig(): Config {
  // Check for required environment variables
  const requiredVars = ['WALLET_MNEMONIC', 'WALLET_PASSWORD'];
  for (const varName of requiredVars) {
    if (!process.env[varName] || process.env[varName] === `your_${varName.toLowerCase()}_here`) {
      throw new Error(`${varName} must be set in environment variables`);
    }
  }

  const config: Config = {
    // Ergo Node Configuration
    ergoNodeUrl: getEnvVar('ERGO_NODE_URL', 'http://213.239.193.208:9053'),
    ergoExplorerUrl: getEnvVar('ERGO_EXPLORER_URL', 'https://api.ergoplatform.com'),
    networkType: getEnvVar('NETWORK_TYPE', 'mainnet') as 'mainnet' | 'testnet',
    ...(process.env.ERGO_NODE_API_KEY && { ergoNodeApiKey: process.env.ERGO_NODE_API_KEY }),

    // Wallet Configuration
    walletMnemonic: getEnvVar('WALLET_MNEMONIC'),
    walletPassword: getEnvVar('WALLET_PASSWORD'),

    // Bot Configuration
    minRentThreshold: getEnvNumber('MIN_RENT_THRESHOLD', 1000000), // 0.001 ERG
    maxBoxesPerTx: getEnvNumber('MAX_BOXES_PER_TX', 50),
    scanInterval: getEnvNumber('SCAN_INTERVAL', 300000), // 5 minutes
    rentFeePerByte: getEnvNumber('RENT_FEE_PER_BYTE', 1250000), // nanoergs per byte
    minBoxValuePerByte: getEnvNumber('MIN_BOX_VALUE_PER_BYTE', 360), // nanoergs per byte

    // Storage Rent Parameters
    storageRentPeriodBlocks: getEnvNumber('STORAGE_RENT_PERIOD_BLOCKS', 1051200), // 4 years
    minStorageRentAgeBlocks: getEnvNumber('MIN_STORAGE_RENT_AGE_BLOCKS', 1051200), // 4 years

    // Database Configuration
    databasePath: getEnvVar('DATABASE_PATH', './data/sr-bot.db'),

    // Logging Configuration
    logLevel: getEnvVar('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
    logDir: getEnvVar('LOG_DIR', './logs'),

    // Transaction Configuration
    transactionFee: getEnvNumber('TRANSACTION_FEE', 1000000), // 0.001 ERG
    maxTransactionSize: getEnvNumber('MAX_TRANSACTION_SIZE', 8192), // bytes

    // Bot Behavior
    dryRun: getEnvBoolean('DRY_RUN', process.env.NODE_ENV === 'dry-run'),
    enableCron: getEnvBoolean('ENABLE_CRON', true),
    cronSchedule: getEnvVar('CRON_SCHEDULE', '*/5 * * * * *'), // Every 5 seconds for height checks

    // Monitoring
    enableMetrics: getEnvBoolean('ENABLE_METRICS', true),
    metricsPort: getEnvNumber('METRICS_PORT', 3000),
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

function validateConfig(config: Config): void {
  // Validate network type
  if (!['mainnet', 'testnet'].includes(config.networkType)) {
    throw new Error('NETWORK_TYPE must be either "mainnet" or "testnet"');
  }

  // Validate log level
  if (!['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error');
  }

  // Validate numeric values
  if (config.minRentThreshold < 0) {
    throw new Error('MIN_RENT_THRESHOLD must be a positive number');
  }

  if (config.maxBoxesPerTx < 1 || config.maxBoxesPerTx > 100) {
    throw new Error('MAX_BOXES_PER_TX must be between 1 and 100');
  }

  if (config.scanInterval < 10000) { // Minimum 10 seconds
    throw new Error('SCAN_INTERVAL must be at least 10000 milliseconds (10 seconds)');
  }

  if (config.rentFeePerByte < 1) {
    throw new Error('RENT_FEE_PER_BYTE must be a positive number');
  }

  if (config.minBoxValuePerByte < 1) {
    throw new Error('MIN_BOX_VALUE_PER_BYTE must be a positive number');
  }

  if (config.storageRentPeriodBlocks < 1) {
    throw new Error('STORAGE_RENT_PERIOD_BLOCKS must be a positive number');
  }

  if (config.minStorageRentAgeBlocks < 1) {
    throw new Error('MIN_STORAGE_RENT_AGE_BLOCKS must be a positive number');
  }

  if (config.transactionFee < 100000) { // Minimum 0.0001 ERG
    throw new Error('TRANSACTION_FEE must be at least 100000 nanoergs');
  }

  if (config.maxTransactionSize < 1024 || config.maxTransactionSize > 32768) {
    throw new Error('MAX_TRANSACTION_SIZE must be between 1024 and 32768 bytes');
  }

  if (config.metricsPort < 1024 || config.metricsPort > 65535) {
    throw new Error('METRICS_PORT must be between 1024 and 65535');
  }

  // Validate wallet mnemonic format (basic check)
  const mnemonicWords = config.walletMnemonic.trim().split(/\s+/);
  if (mnemonicWords.length !== 12 && mnemonicWords.length !== 15 && mnemonicWords.length !== 24) {
    throw new Error('WALLET_MNEMONIC must be 12, 15, or 24 words');
  }

  // Validate URLs
  try {
    new URL(config.ergoNodeUrl);
  } catch {
    throw new Error('ERGO_NODE_URL must be a valid URL');
  }

  try {
    new URL(config.ergoExplorerUrl);
  } catch {
    throw new Error('ERGO_EXPLORER_URL must be a valid URL');
  }
}

// Export singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// Storage rent constants
export const STORAGE_RENT_CONSTANTS = {
  RENT_PERIOD_BLOCKS: 1051200, // ~4 years
  MIN_RENT_AGE_BLOCKS: 1051200,
  RENT_FEE_PER_BYTE: 1250000, // nanoergs
  MIN_VALUE_PER_BYTE: 360, // nanoergs
} as const;

// Export for testing
export { validateConfig }; 