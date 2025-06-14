import { Box } from '@fleet-sdk/core';

export interface Config {
  // Ergo Node Configuration
  ergoNodeUrl: string;
  ergoNodeApiKey?: string;
  ergoExplorerUrl: string;
  networkType: 'mainnet' | 'testnet';

  // Wallet Configuration
  walletMnemonic: string;
  walletPassword: string;

  // Bot Configuration
  minRentThreshold: number;
  maxBoxesPerTx: number;
  scanInterval: number;
  rentFeePerByte: number;
  minBoxValuePerByte: number;

  // Storage Rent Parameters
  storageRentPeriodBlocks: number;
  minStorageRentAgeBlocks: number;

  // Database Configuration
  databasePath: string;

  // Logging Configuration
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logDir: string;

  // Transaction Configuration
  transactionFee: number;
  maxTransactionSize: number;

  // Bot Behavior
  dryRun: boolean;
  enableCron: boolean;
  cronSchedule: string;

  // Monitoring
  enableMetrics: boolean;
  metricsPort: number;
}

export interface EligibleBox {
  boxId: string;
  creationHeight: number;
  currentHeight: number;
  boxSize: number;
  value: bigint;
  rentFee: bigint;
  status: 'pending' | 'queued' | 'claimed' | 'insufficient_funds' | 'error';
  discoveredAt: Date;
  claimedAt?: Date;
  txId?: string;
  ergoTree: string;
  assets: Array<{
    tokenId: string;
    amount: bigint;
  }>;
  additionalRegisters: Record<string, string>;
}

export interface TransactionResult {
  txId: string;
  boxIds: string[];
  totalRentCollected: bigint;
  transactionFee: bigint;
  status: 'pending' | 'confirmed' | 'failed';
  createdAt: Date;
}

export interface BotState {
  key: string;
  value: string;
  updatedAt: Date;
}

export interface BotMetrics {
  totalBoxesScanned: number;
  eligibleBoxesFound: number;
  totalRentCollected: bigint;
  totalTransactionsFees: bigint;
  successfulTransactions: number;
  failedTransactions: number;
  averageProcessingTime: number;
  lastScanHeight: number;
  lastScanTime: Date;
  walletBalance: bigint;
}

export interface NodeInfo {
  name: string;
  appVersion: string;
  fullHeight: number;
  headersHeight: number;
  maxPeerHeight: number;
  bestFullHeaderId: string;
  previousFullHeaderId: string;
  stateType: string;
  difficulty: number;
  unconfirmedCount: number;
  headersScore: number;
  fullBlocksScore: number;
  launchTime: number;
  parameters: {
    height: number;
    storageFeeFactor: number;
    minValuePerByte: number;
    maxBlockSize: number;
    maxBlockCost: number;
    blockVersion: number;
    tokenAccessCost: number;
    inputCost: number;
    dataInputCost: number;
    outputCost: number;
  };
}

export interface BoxData {
  boxId: string;
  transactionId: string;
  blockId: string;
  value: string;
  index: number;
  globalIndex: number;
  creationHeight: number;
  settlementHeight: number;
  ergoTree: string;
  address: string;
  assets: Array<{
    tokenId: string;
    index: number;
    amount: string;
    name?: string;
    decimals?: number;
    type?: string;
  }>;
  additionalRegisters: Record<string, string>;
  spentTransactionId?: string;
  mainChain: boolean;
}

export interface TransactionData {
  id: string;
  blockId: string;
  inclusionHeight: number;
  timestamp: number;
  index: number;
  globalIndex: number;
  numConfirmations: number;
  inputs: Array<{
    boxId: string;
    spendingProof: {
      proofBytes: string;
      extension: Record<string, string>;
    };
  }>;
  dataInputs: Array<{
    boxId: string;
  }>;
  outputs: BoxData[];
  size: number;
}

export interface ScanResult {
  eligibleBoxes: EligibleBox[];
  totalScanned: number;
  currentHeight: number;
  scanDuration: number;
}

export interface ProcessingResult {
  processedBoxes: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalRentCollected: bigint;
  totalFeesPaid: bigint;
  errors: string[];
}

export interface DatabaseSchema {
  eligible_boxes: {
    box_id: string;
    creation_height: number;
    current_height: number;
    box_size: number;
    value: string;
    rent_fee: string;
    status: string;
    discovered_at: string;
    claimed_at?: string;
    tx_id?: string;
    ergo_tree: string;
    assets: string; // JSON
    additional_registers: string; // JSON
  };
  transactions: {
    tx_id: string;
    box_ids: string; // JSON array
    total_rent_collected: string;
    transaction_fee: string;
    created_at: string;
    status: string;
  };
  bot_state: {
    key: string;
    value: string;
    updated_at: string;
  };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component: string;
  operation?: string;
  boxId?: string;
  txId?: string;
  height?: number;
  duration?: number;
  error?: Error;
} 