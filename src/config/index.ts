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

function getEnvList(name: string, defaultValue: string = ''): string[] {
  const value = process.env[name] ?? defaultValue;
  return value
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const ergoNodeUrl = getEnvVar('ERGO_NODE_URL', 'http://128.253.41.49:9053');
  const defaultStorageRentCollectAddress = '9fLXRjthKecc7LsHyQAF9w2DfqVbsFxsHqUBpz2ouBPYRmaBxfT';
  const walletMnemonic = getOptionalEnvVar('WALLET_MNEMONIC', [
    'your_wallet_mnemonic_phrase_here',
    'your twelve word mnemonic phrase here'
  ]);
  const walletPassword = getOptionalEnvVar('WALLET_PASSWORD', [
    'your_wallet_password_here',
    'your_wallet_password'
  ]);

  const config: Config = {
    // Ergo Node Configuration
    ergoNodeUrl,
    txSubmitNodeUrl: getEnvVar('TX_SUBMIT_NODE_URL', ergoNodeUrl),
    ergoExplorerUrl: getEnvVar('ERGO_EXPLORER_URL', 'https://api.ergoplatform.com'),
    networkType: getEnvVar('NETWORK_TYPE', 'mainnet') as 'mainnet' | 'testnet',
    ...(process.env.ERGO_NODE_API_KEY && { ergoNodeApiKey: process.env.ERGO_NODE_API_KEY }),
    additionalSubmitNodeUrls: getEnvList('ADDITIONAL_SUBMIT_NODE_URLS', 'http://213.239.193.208:9053,http://128.253.41.102:9053'),
    enableNodeDiscovery: getEnvBoolean('ENABLE_NODE_DISCOVERY', true),
    nodeDiscoveryUrl: getEnvVar('NODE_DISCOVERY_URL', 'https://ergonodes.net/list?page=1&itemsPerPage=1000&reachable=on'),
    nodeDiscoveryRestPort: getEnvNumber('NODE_DISCOVERY_REST_PORT', 9053),
    nodeDiscoveryCacheMs: getEnvNumber('NODE_DISCOVERY_CACHE_MS', 300000),
    nodeBlacklistMs: getEnvNumber('NODE_BLACKLIST_MS', 600000),
    nodeProbeTimeout: getEnvNumber('NODE_PROBE_TIMEOUT', 2500),
    nodeProbeConcurrency: getEnvNumber('NODE_PROBE_CONCURRENCY', 64),
    enableSubmitBroadcast: getEnvBoolean('ENABLE_SUBMIT_BROADCAST', true),
    confirmPrimaryBeforeBroadcast: getEnvBoolean('CONFIRM_PRIMARY_BEFORE_BROADCAST', false),

    // Wallet Configuration
    ...(walletMnemonic && { walletMnemonic }),
    ...(walletPassword && { walletPassword }),

    // Bot Configuration
    minRentThreshold: getEnvNumber('MIN_RENT_THRESHOLD', 1000000), // 0.001 ERG
    maxBoxesPerTx: getEnvNumber('MAX_BOXES_PER_TX', 50),
    scanInterval: getEnvNumber('SCAN_INTERVAL', 300000), // 5 minutes
    scanBoxRangeBatchSize: getEnvNumber('SCAN_BOX_RANGE_BATCH_SIZE', 50),
    scanMaxRangesPerCycle: getEnvNumber('SCAN_MAX_RANGES_PER_CYCLE', 20),
    scanRequestTimeout: getEnvNumber('SCAN_REQUEST_TIMEOUT', 20000),
    scanBoxDetailConcurrency: getEnvNumber('SCAN_BOX_DETAIL_CONCURRENCY', 16),
    scanIndexLookback: getEnvNumber('SCAN_INDEX_LOOKBACK', 1000),
    scanIndexLookahead: getEnvNumber('SCAN_INDEX_LOOKAHEAD', 1000),
    scanRecentIndexLookback: getEnvNumber('SCAN_RECENT_INDEX_LOOKBACK', 1000),
    scanFutureBlockWindow: getEnvNumber('SCAN_FUTURE_BLOCK_WINDOW', 1000),
    rentFeePerByte: getEnvNumber('RENT_FEE_PER_BYTE', 1250000), // fallback only; node params win
    minBoxValuePerByte: getEnvNumber('MIN_BOX_VALUE_PER_BYTE', 360), // fallback only; node params win

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
    storageRentMode: getEnvVar('STORAGE_RENT_MODE', 'miner').toLowerCase() as 'miner' | 'address',
    storageRentCollectAddress: getEnvVar('STORAGE_RENT_COLLECT_ADDRESS', defaultStorageRentCollectAddress).trim(),

    // Bot Behavior
    dryRun: getEnvBoolean('DRY_RUN', process.env.NODE_ENV === 'dry-run'),
    enableCron: getEnvBoolean('ENABLE_CRON', true),
    cronSchedule: getEnvVar('CRON_SCHEDULE', '*/2 * * * * *'), // Every 2 seconds for competitive claiming

    // Monitoring
    enableMetrics: getEnvBoolean('ENABLE_METRICS', true),
    metricsPort: getEnvNumber('METRICS_PORT', 3000),
    enableUi: getEnvBoolean('ENABLE_UI', false),
    uiHost: getEnvVar('UI_HOST', '127.0.0.1'),
    uiPort: getEnvNumber('UI_PORT', 8787),
    uiRefreshMs: getEnvNumber('UI_REFRESH_MS', 2000),
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

function getOptionalEnvVar(name: string, placeholders: string[]): string | undefined {
  const value = process.env[name]?.trim();
  if (!value || placeholders.includes(value)) {
    return undefined;
  }
  return value;
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

  if (config.scanBoxRangeBatchSize < 1 || config.scanBoxRangeBatchSize > 100) {
    throw new Error('SCAN_BOX_RANGE_BATCH_SIZE must be between 1 and 100');
  }

  if (config.scanMaxRangesPerCycle < 1 || config.scanMaxRangesPerCycle > 1000) {
    throw new Error('SCAN_MAX_RANGES_PER_CYCLE must be between 1 and 1000');
  }

  if (config.scanRequestTimeout < 1000 || config.scanRequestTimeout > 60000) {
    throw new Error('SCAN_REQUEST_TIMEOUT must be between 1000 and 60000 milliseconds');
  }

  if (config.scanBoxDetailConcurrency < 1 || config.scanBoxDetailConcurrency > 32) {
    throw new Error('SCAN_BOX_DETAIL_CONCURRENCY must be between 1 and 32');
  }

  if (config.scanIndexLookback < 0 || config.scanIndexLookback > 100000) {
    throw new Error('SCAN_INDEX_LOOKBACK must be between 0 and 100000');
  }

  if (config.scanIndexLookahead < 0 || config.scanIndexLookahead > 100000) {
    throw new Error('SCAN_INDEX_LOOKAHEAD must be between 0 and 100000');
  }

  if (config.scanRecentIndexLookback < 0 || config.scanRecentIndexLookback > 100000) {
    throw new Error('SCAN_RECENT_INDEX_LOOKBACK must be between 0 and 100000');
  }

  if (config.scanFutureBlockWindow < 0 || config.scanFutureBlockWindow > config.storageRentPeriodBlocks) {
    throw new Error('SCAN_FUTURE_BLOCK_WINDOW must be between 0 and STORAGE_RENT_PERIOD_BLOCKS');
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

  if (!['miner', 'address'].includes(config.storageRentMode)) {
    throw new Error('STORAGE_RENT_MODE must be either "miner" or "address"');
  }

  if (config.storageRentMode === 'address' && !config.storageRentCollectAddress) {
    throw new Error('STORAGE_RENT_COLLECT_ADDRESS is required when STORAGE_RENT_MODE=address');
  }

  if (config.metricsPort < 1024 || config.metricsPort > 65535) {
    throw new Error('METRICS_PORT must be between 1024 and 65535');
  }

  if (config.uiPort < 1024 || config.uiPort > 65535) {
    throw new Error('UI_PORT must be between 1024 and 65535');
  }

  if (config.uiRefreshMs < 500 || config.uiRefreshMs > 60000) {
    throw new Error('UI_REFRESH_MS must be between 500 and 60000 milliseconds');
  }

  if (config.walletMnemonic || config.walletPassword) {
    if (!config.walletMnemonic || !config.walletPassword) {
      throw new Error('WALLET_MNEMONIC and WALLET_PASSWORD must be provided together');
    }

    const mnemonicWords = config.walletMnemonic.trim().split(/\s+/);
    if (mnemonicWords.length !== 12 && mnemonicWords.length !== 15 && mnemonicWords.length !== 24) {
      throw new Error('WALLET_MNEMONIC must be 12, 15, or 24 words');
    }
  }

  // Validate URLs
  try {
    new URL(config.ergoNodeUrl);
  } catch {
    throw new Error('ERGO_NODE_URL must be a valid URL');
  }

  try {
    new URL(config.txSubmitNodeUrl);
  } catch {
    throw new Error('TX_SUBMIT_NODE_URL must be a valid URL');
  }

  for (const nodeUrl of config.additionalSubmitNodeUrls) {
    try {
      new URL(nodeUrl);
    } catch {
      throw new Error(`ADDITIONAL_SUBMIT_NODE_URLS contains an invalid URL: ${nodeUrl}`);
    }
  }

  try {
    new URL(config.ergoExplorerUrl);
  } catch {
    throw new Error('ERGO_EXPLORER_URL must be a valid URL');
  }

  try {
    new URL(config.nodeDiscoveryUrl);
  } catch {
    throw new Error('NODE_DISCOVERY_URL must be a valid URL');
  }

  if (config.nodeDiscoveryRestPort < 1 || config.nodeDiscoveryRestPort > 65535) {
    throw new Error('NODE_DISCOVERY_REST_PORT must be between 1 and 65535');
  }

  if (config.nodeDiscoveryCacheMs < 10000 || config.nodeDiscoveryCacheMs > 3600000) {
    throw new Error('NODE_DISCOVERY_CACHE_MS must be between 10000 and 3600000 milliseconds');
  }

  if (config.nodeBlacklistMs < 10000 || config.nodeBlacklistMs > 3600000) {
    throw new Error('NODE_BLACKLIST_MS must be between 10000 and 3600000 milliseconds');
  }

  if (config.nodeProbeTimeout < 500 || config.nodeProbeTimeout > 30000) {
    throw new Error('NODE_PROBE_TIMEOUT must be between 500 and 30000 milliseconds');
  }

  if (config.nodeProbeConcurrency < 1 || config.nodeProbeConcurrency > 64) {
    throw new Error('NODE_PROBE_CONCURRENCY must be between 1 and 64');
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
