import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { EligibleBox, TransactionResult, BotState, BotMetrics } from '../types';

export class Database {
  private db: sqlite3.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new sqlite3.Database(dbPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    const createTablesSQL = `
      -- Table for eligible boxes
      CREATE TABLE IF NOT EXISTS eligible_boxes (
        box_id TEXT PRIMARY KEY,
        creation_height INTEGER NOT NULL,
        current_height INTEGER NOT NULL,
        box_size INTEGER NOT NULL,
        value TEXT NOT NULL,
        rent_fee TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        discovered_at TEXT NOT NULL,
        claimed_at TEXT,
        tx_id TEXT,
        ergo_tree TEXT NOT NULL,
        assets TEXT NOT NULL DEFAULT '[]',
        additional_registers TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (tx_id) REFERENCES transactions(tx_id)
      );

      -- Table for transactions
      CREATE TABLE IF NOT EXISTS transactions (
        tx_id TEXT PRIMARY KEY,
        box_ids TEXT NOT NULL,
        total_rent_collected TEXT NOT NULL,
        transaction_fee TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );

      -- Table for bot state
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_eligible_boxes_status ON eligible_boxes(status);
      CREATE INDEX IF NOT EXISTS idx_eligible_boxes_discovered_at ON eligible_boxes(discovered_at);
      CREATE INDEX IF NOT EXISTS idx_eligible_boxes_creation_height ON eligible_boxes(creation_height);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    `;

    this.db.exec(createTablesSQL, (err) => {
      if (err) {
        throw new Error(`Failed to initialize database tables: ${err.message}`);
      }
    });
  }

  // Eligible boxes operations
  async insertEligibleBox(box: EligibleBox): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT OR REPLACE INTO eligible_boxes (
          box_id, creation_height, current_height, box_size, value, rent_fee,
          status, discovered_at, claimed_at, tx_id, ergo_tree, assets, additional_registers
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        box.boxId,
        box.creationHeight,
        box.currentHeight,
        box.boxSize,
        box.value.toString(),
        box.rentFee.toString(),
        box.status,
        box.discoveredAt.toISOString(),
        box.claimedAt?.toISOString() || null,
        box.txId || null,
        box.ergoTree,
        JSON.stringify(box.assets),
        JSON.stringify(box.additionalRegisters)
      ];

      this.db.run(sql, params, function(err) {
        if (err) {
          reject(new Error(`Failed to insert eligible box: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async getEligibleBoxes(status?: string): Promise<EligibleBox[]> {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM eligible_boxes';
      const params: any[] = [];

      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }

      sql += ' ORDER BY discovered_at DESC';

      this.db.all(sql, params, (err, rows: any[]) => {
        if (err) {
          reject(new Error(`Failed to get eligible boxes: ${err.message}`));
        } else {
          const boxes = rows.map(row => ({
            boxId: row.box_id,
            creationHeight: row.creation_height,
            currentHeight: row.current_height,
            boxSize: row.box_size,
            value: BigInt(row.value),
            rentFee: BigInt(row.rent_fee),
            status: row.status,
            discoveredAt: new Date(row.discovered_at),
            ...(row.claimed_at && { claimedAt: new Date(row.claimed_at) }),
            ...(row.tx_id && { txId: row.tx_id }),
            ergoTree: row.ergo_tree,
            assets: JSON.parse(row.assets),
            additionalRegisters: JSON.parse(row.additional_registers)
          }));
          resolve(boxes);
        }
      });
    });
  }

  async updateBoxStatus(boxId: string, status: string, txId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = `
        UPDATE eligible_boxes 
        SET status = ?, tx_id = ?, claimed_at = ?
        WHERE box_id = ?
      `;

      const claimedAt = status === 'claimed' ? new Date().toISOString() : null;
      const params = [status, txId || null, claimedAt, boxId];

      this.db.run(sql, params, function(err) {
        if (err) {
          reject(new Error(`Failed to update box status: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async getBoxById(boxId: string): Promise<EligibleBox | null> {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM eligible_boxes WHERE box_id = ?';

      this.db.get(sql, [boxId], (err, row: any) => {
        if (err) {
          reject(new Error(`Failed to get box by ID: ${err.message}`));
        } else if (!row) {
          resolve(null);
        } else {
          const box: EligibleBox = {
            boxId: row.box_id,
            creationHeight: row.creation_height,
            currentHeight: row.current_height,
            boxSize: row.box_size,
            value: BigInt(row.value),
            rentFee: BigInt(row.rent_fee),
            status: row.status,
            discoveredAt: new Date(row.discovered_at),
            ergoTree: row.ergo_tree,
            assets: JSON.parse(row.assets),
            additionalRegisters: JSON.parse(row.additional_registers),
            ...(row.claimed_at && { claimedAt: new Date(row.claimed_at) }),
            ...(row.tx_id && { txId: row.tx_id })
          };
          resolve(box);
        }
      });
    });
  }

  // Transaction operations
  async insertTransaction(transaction: TransactionResult): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT OR REPLACE INTO transactions (
          tx_id, box_ids, total_rent_collected, transaction_fee, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `;

      const params = [
        transaction.txId,
        JSON.stringify(transaction.boxIds),
        transaction.totalRentCollected.toString(),
        transaction.transactionFee.toString(),
        transaction.createdAt.toISOString(),
        transaction.status
      ];

      this.db.run(sql, params, function(err) {
        if (err) {
          reject(new Error(`Failed to insert transaction: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async getTransactions(status?: string): Promise<TransactionResult[]> {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM transactions';
      const params: any[] = [];

      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }

      sql += ' ORDER BY created_at DESC';

      this.db.all(sql, params, (err, rows: any[]) => {
        if (err) {
          reject(new Error(`Failed to get transactions: ${err.message}`));
        } else {
          const transactions = rows.map(row => ({
            txId: row.tx_id,
            boxIds: JSON.parse(row.box_ids),
            totalRentCollected: BigInt(row.total_rent_collected),
            transactionFee: BigInt(row.transaction_fee),
            createdAt: new Date(row.created_at),
            status: row.status
          }));
          resolve(transactions);
        }
      });
    });
  }

  async updateTransactionStatus(txId: string, status: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = 'UPDATE transactions SET status = ? WHERE tx_id = ?';

      this.db.run(sql, [status, txId], function(err) {
        if (err) {
          reject(new Error(`Failed to update transaction status: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Bot state operations
  async setBotState(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT OR REPLACE INTO bot_state (key, value, updated_at)
        VALUES (?, ?, ?)
      `;

      this.db.run(sql, [key, value, new Date().toISOString()], function(err) {
        if (err) {
          reject(new Error(`Failed to set bot state: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async getBotState(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT value FROM bot_state WHERE key = ?';

      this.db.get(sql, [key], (err, row: any) => {
        if (err) {
          reject(new Error(`Failed to get bot state: ${err.message}`));
        } else {
          resolve(row ? row.value : null);
        }
      });
    });
  }

  async getAllBotState(): Promise<BotState[]> {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM bot_state ORDER BY updated_at DESC';

      this.db.all(sql, [], (err, rows: any[]) => {
        if (err) {
          reject(new Error(`Failed to get all bot state: ${err.message}`));
        } else {
          const states = rows.map(row => ({
            key: row.key,
            value: row.value,
            updatedAt: new Date(row.updated_at)
          }));
          resolve(states);
        }
      });
    });
  }

  // Metrics and statistics
  async getBotMetrics(): Promise<BotMetrics> {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT 
          COUNT(*) as total_boxes_scanned,
          COUNT(CASE WHEN status != 'insufficient_funds' THEN 1 END) as eligible_boxes_found,
          COALESCE(SUM(CASE WHEN status = 'claimed' THEN CAST(rent_fee AS INTEGER) ELSE 0 END), 0) as total_rent_collected,
          MAX(current_height) as last_scan_height,
          MAX(discovered_at) as last_scan_time
        FROM eligible_boxes
      `;

      this.db.get(sql, [], async (err, row: any) => {
        if (err) {
          reject(new Error(`Failed to get box metrics: ${err.message}`));
          return;
        }

        try {
          const transactionMetrics = await this.getTransactionMetrics();
          const walletBalance = await this.getBotState('wallet_balance');

          const metrics: BotMetrics = {
            totalBoxesScanned: row.total_boxes_scanned || 0,
            eligibleBoxesFound: row.eligible_boxes_found || 0,
            totalRentCollected: BigInt(row.total_rent_collected || 0),
            totalTransactionsFees: transactionMetrics.totalFees,
            successfulTransactions: transactionMetrics.successful,
            failedTransactions: transactionMetrics.failed,
            averageProcessingTime: 0, // TODO: Implement timing tracking
            lastScanHeight: row.last_scan_height || 0,
            lastScanTime: row.last_scan_time ? new Date(row.last_scan_time) : new Date(0),
            walletBalance: walletBalance ? BigInt(walletBalance) : 0n
          };

          resolve(metrics);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async getTransactionMetrics(): Promise<{ totalFees: bigint; successful: number; failed: number }> {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT 
          COALESCE(SUM(CAST(transaction_fee AS INTEGER)), 0) as total_fees,
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as successful,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
        FROM transactions
      `;

      this.db.get(sql, [], (err, row: any) => {
        if (err) {
          reject(new Error(`Failed to get transaction metrics: ${err.message}`));
        } else {
          resolve({
            totalFees: BigInt(row.total_fees || 0),
            successful: row.successful || 0,
            failed: row.failed || 0
          });
        }
      });
    });
  }

  // Cleanup operations
  async cleanupOldRecords(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffISO = cutoffDate.toISOString();

    return new Promise((resolve, reject) => {
      const sql = `
        DELETE FROM eligible_boxes 
        WHERE status IN ('claimed', 'error') 
        AND discovered_at < ?
      `;

      this.db.run(sql, [cutoffISO], function(err) {
        if (err) {
          reject(new Error(`Failed to cleanup old records: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Database maintenance
  async vacuum(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run('VACUUM', (err) => {
        if (err) {
          reject(new Error(`Failed to vacuum database: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Close database connection
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(new Error(`Failed to close database: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT 1 as test', (err, row) => {
        if (err) {
          reject(new Error(`Database health check failed: ${err.message}`));
        } else {
          resolve(!!row);
        }
      });
    });
  }
}

// Export singleton database instance
let databaseInstance: Database | null = null;

export function createDatabase(dbPath: string): Database {
  if (!databaseInstance) {
    databaseInstance = new Database(dbPath);
  }
  return databaseInstance;
}

export function getDatabase(): Database {
  if (!databaseInstance) {
    throw new Error('Database not initialized. Call createDatabase() first.');
  }
  return databaseInstance;
} 