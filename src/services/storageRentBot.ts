import * as cron from 'node-cron';
import { Config, EligibleBox, TransactionResult, ProcessingResult, ScanResult, BotMetrics } from '../types';
import { ErgoNodeService } from './ergoNode';
import { TransactionService } from './transactionService';
import { Database } from '../database';

export class StorageRentBot {
  private config: Config;
  private ergoNode: ErgoNodeService;
  private transactionService: TransactionService;
  private database: Database;
  private isRunning: boolean = false;
  private cronJob: cron.ScheduledTask | null = null;
  private lastQueueScanHeight: number = 0;
  private queuedBoxesByHeight: Map<number, EligibleBox[]> = new Map();
  private lastSearchOffset: number = 0;
  private startTime: Date;
  private logger: any; // Will be injected

  constructor(
    config: Config,
    ergoNode: ErgoNodeService,
    transactionService: TransactionService,
    database: Database,
    logger: any
  ) {
    this.config = config;
    this.ergoNode = ergoNode;
    this.transactionService = transactionService;
    this.database = database;
    this.logger = logger;
    this.startTime = new Date();
  }

  // Initialize the bot
  async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing Storage Rent Bot', { component: 'bot' });

      // Test node connectivity
      const nodeHealthy = await this.ergoNode.healthCheck();
      if (!nodeHealthy) {
        throw new Error('Ergo node is not accessible');
      }
      this.logger.info('Ergo node connectivity verified', { component: 'bot' });

      // Test database connectivity
      const dbHealthy = await this.database.healthCheck();
      if (!dbHealthy) {
        throw new Error('Database is not accessible');
      }
      this.logger.info('Database connectivity verified', { component: 'bot' });

      // Store initialization time
      await this.database.setBotState('initialized_at', new Date().toISOString());
      await this.database.setBotState('wallet_address', this.transactionService.getWalletAddress());

      this.logger.info('Storage Rent Bot initialized successfully', { 
        component: 'bot',
        walletAddress: this.transactionService.getWalletAddress()
      });

    } catch (error) {
      this.logger.error('Failed to initialize Storage Rent Bot', { 
        component: 'bot', 
        error: error as Error 
      });
      throw error;
    }
  }

  // Start the bot
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Bot is already running', { component: 'bot' });
      return;
    }

    try {
      this.isRunning = true;
      await this.database.setBotState('status', 'running');
      await this.database.setBotState('started_at', new Date().toISOString());

      this.logger.info('Starting Storage Rent Bot', { 
        component: 'bot',
        dryRun: this.config.dryRun,
        cronEnabled: this.config.enableCron
      });

      // Run initial scan
      await this.runScanAndProcess();

      // Set up cron job if enabled
      if (this.config.enableCron) {
        this.setupCronJob();
      }

      this.logger.info('Storage Rent Bot started successfully', { component: 'bot' });

    } catch (error) {
      this.isRunning = false;
      await this.database.setBotState('status', 'error');
      this.logger.error('Failed to start Storage Rent Bot', { 
        component: 'bot', 
        error: error as Error 
      });
      throw error;
    }
  }

  // Stop the bot
  async stop(): Promise<void> {
    this.logger.info('Stopping Storage Rent Bot', { component: 'bot' });

    this.isRunning = false;
    
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    await this.database.setBotState('status', 'stopped');
    await this.database.setBotState('stopped_at', new Date().toISOString());

    this.logger.info('Storage Rent Bot stopped', { component: 'bot' });
  }

  // Set up cron job for periodic scanning
  private setupCronJob(): void {
    if (!cron.validate(this.config.cronSchedule)) {
      throw new Error(`Invalid cron schedule: ${this.config.cronSchedule}`);
    }

    this.cronJob = cron.schedule(this.config.cronSchedule, async () => {
      if (this.isRunning) {
        this.logger.info('Running scheduled scan', { component: 'cron' });
        try {
          await this.runScanAndProcess();
        } catch (error) {
          this.logger.error('Scheduled scan failed', { 
            component: 'cron', 
            error: error as Error 
          });
        }
      }
    }, {
      scheduled: false // Don't start immediately
    });

    this.cronJob.start();
    this.logger.info('Cron job scheduled', { 
      component: 'bot', 
      schedule: this.config.cronSchedule 
    });
  }

  // Main scan and process cycle
  async runScanAndProcess(): Promise<ProcessingResult> {
    const startTime = Date.now();
    
    try {
      const currentHeight = await this.ergoNode.getCurrentHeight();
      
      // Check if we need to do a full queue scan (every 50 blocks ~1.5 hours)
      const shouldScanQueue = currentHeight - this.lastQueueScanHeight >= 50;
      
      if (shouldScanQueue) {
        this.logger.info('Starting queue scan cycle', { component: 'bot' });
        
        // Do full scan to find new boxes to queue, organized by height
        const { boxesByHeight, nextOffset } = await this.ergoNode.scanForEligibleBoxes(
          currentHeight,
          this.config.minStorageRentAgeBlocks,
          this.lastSearchOffset,
          50
        );
        
        // Merge new boxes into our existing queue by height
        for (const [height, boxes] of boxesByHeight) {
          if (!this.queuedBoxesByHeight.has(height)) {
            this.queuedBoxesByHeight.set(height, []);
          }
          this.queuedBoxesByHeight.get(height)!.push(...boxes);
        }
        
        this.lastQueueScanHeight = currentHeight;
        this.lastSearchOffset = nextOffset;
        
        const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
        this.logger.info(`Queue scan complete: found ${boxesByHeight.size} height groups with ${totalQueuedBoxes} total boxes queued`, { component: 'bot' });
      }
      
      // Always check if any queued boxes are now eligible
      this.logger.info('Checking queued boxes for eligibility', { component: 'bot' });
      
      const minAge = this.config.minStorageRentAgeBlocks;
      const cutoffHeight = currentHeight - minAge;
      
      this.logger.info(`Checking eligibility: currentHeight=${currentHeight}, minAge=${minAge}, cutoffHeight=${cutoffHeight}`, { component: 'processor' });
      
      // Find all boxes from heights that are now eligible
      const nowEligible: EligibleBox[] = [];
      const heightsToRemove: number[] = [];
      
      for (const [height, boxes] of this.queuedBoxesByHeight) {
        const eligibleAtHeight = height + minAge;
        const isEligible = currentHeight > eligibleAtHeight; // Require strictly greater to be safe
        
        this.logger.info(`Height ${height}: eligibleAt=${eligibleAtHeight}, current=${currentHeight}, isEligible=${isEligible}`, { component: 'processor' });
        
        if (isEligible) {
          nowEligible.push(...boxes);
          heightsToRemove.push(height);
        }
      }
      
      // Remove processed height groups from queue
      for (const height of heightsToRemove) {
        this.queuedBoxesByHeight.delete(height);
      }
      
      if (nowEligible.length === 0) {
        // Show detailed info about queued boxes and when they'll be eligible
        if (this.queuedBoxesByHeight.size === 0) {
          this.logger.info('No boxes in queue - need to perform a queue scan', { component: 'processor' });
        } else {
          // Find the next eligible boxes and show when they'll be ready
          const sortedHeights = Array.from(this.queuedBoxesByHeight.keys()).sort((a, b) => a - b);
          if (sortedHeights.length === 0) {
            this.logger.info('Queue exists but is empty', { component: 'processor' });
            const emptyResult: ProcessingResult = {
              processedBoxes: 0,
              successfulTransactions: 0,
              failedTransactions: 0,
              totalRentCollected: 0n,
              totalFeesPaid: 0n,
              errors: []
            };
            return emptyResult;
          }
          
          const nextEligibleHeight = sortedHeights[0]!; // Safe after length check
          const nextEligibleBoxes = this.queuedBoxesByHeight.get(nextEligibleHeight);
          if (!nextEligibleBoxes) {
            this.logger.warn('No boxes found for next eligible height', { component: 'processor', nextEligibleHeight });
            const emptyResult: ProcessingResult = {
              processedBoxes: 0,
              successfulTransactions: 0,
              failedTransactions: 0,
              totalRentCollected: 0n,
              totalFeesPaid: 0n,
              errors: []
            };
            return emptyResult;
          }
          
          const claimableAtHeight = nextEligibleHeight + minAge;
          const blocksUntilClaimable = claimableAtHeight - currentHeight;
          
          // Get next eligible box IDs
          const nextEligibleBoxIds = nextEligibleBoxes.slice(0, 5).map(box => box.boxId);
          const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
          
          this.logger.info(`NEXT ELIGIBLE BOXES: ${nextEligibleBoxes.length} boxes at height ${nextEligibleHeight} will be claimable in ${blocksUntilClaimable} blocks (~${Math.round(blocksUntilClaimable * 2)} min)`, { 
            component: 'processor',
            currentHeight,
            cutoffHeight,
            totalQueuedBoxes,
            nextEligibleHeight,
            claimableAtHeight,
            blocksUntilClaimable,
            nextEligibleCount: nextEligibleBoxes.length,
            nextEligibleBoxIds,
            estimatedTimeMinutes: Math.round(blocksUntilClaimable * 2) // ~2 minutes per block
          });
          
          // Show the actual box IDs more prominently
          this.logger.info(`Next eligible box IDs: ${nextEligibleBoxIds.join(', ')}${nextEligibleBoxes.length > 5 ? ` ...and ${nextEligibleBoxes.length - 5} more` : ''}`, { component: 'processor' });
          
          // Show summary of all queued heights
          this.logger.info('Queued boxes summary by height:', { component: 'processor' });
          for (const height of sortedHeights.slice(0, 5)) { // Show first 5 heights
            const boxes = this.queuedBoxesByHeight.get(height)!;
            const claimableAt = height + minAge;
            const blocksUntil = claimableAt - currentHeight;
            this.logger.info(`  Height ${height}: ${boxes.length} boxes → eligible in ${blocksUntil} blocks`, { component: 'processor' });
          }
        }
        
        const emptyResult: ProcessingResult = {
          processedBoxes: 0,
          successfulTransactions: 0,
          failedTransactions: 0,
          totalRentCollected: 0n,
          totalFeesPaid: 0n,
          errors: []
        };
        return emptyResult;
      }
      
      this.logger.info(`Found ${nowEligible.length} newly eligible boxes from ${heightsToRemove.length} height groups!`, { component: 'processor' });
      
      // Update wallet balance
      await this.updateWalletBalance();
      
      // Process the newly eligible boxes
      const processingResult = await this.processEligibleBoxes(nowEligible);

      // Update metrics
      await this.updateMetrics();

      const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
      const duration = Date.now() - startTime;
      this.logger.info('Scan and process cycle completed', {
        component: 'bot',
        duration,
        scanned: 0,
        eligible: nowEligible.length,
        processed: processingResult.processedBoxes,
        successful: processingResult.successfulTransactions,
        failed: processingResult.failedTransactions,
        queued: totalQueuedBoxes,
        queuedHeights: this.queuedBoxesByHeight.size,
        lastSearchOffset: this.lastSearchOffset
      });

      return processingResult;

    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('Scan and process cycle failed', {
        component: 'bot',
        duration,
        error: error as Error
      });
      throw error;
    }
  }


  // Process eligible boxes by creating and submitting transactions
  private async processEligibleBoxes(eligibleBoxes: EligibleBox[]): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processedBoxes: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalRentCollected: 0n,
      totalFeesPaid: 0n,
      errors: []
    };

    if (eligibleBoxes.length === 0) {
      this.logger.info('No eligible boxes to process', { component: 'processor' });
      return result;
    }

    try {
      this.logger.info('Starting box processing', {
        component: 'processor',
        totalBoxes: eligibleBoxes.length,
        dryRun: this.config.dryRun
      });

      // Save newly eligible boxes to database first
      for (const box of eligibleBoxes) {
        try {
          await this.database.insertEligibleBox(box);
        } catch (error) {
          this.logger.warn('Failed to save eligible box to database', {
            component: 'processor',
            boxId: box.boxId,
            error: error as Error
          });
        }
      }
      
      // Validate the passed eligible boxes are still unspent
      const boxIds = eligibleBoxes.map(box => box.boxId);
      const validation = await this.ergoNode.validateBoxes(boxIds);
      
      // Update invalid boxes in database
      for (const invalidBoxId of validation.invalid) {
        await this.database.updateBoxStatus(invalidBoxId, 'error', undefined);
      }

      // Filter to only valid boxes
      const validBoxes = eligibleBoxes.filter(box => 
        validation.valid.includes(box.boxId)
      );

      if (validBoxes.length === 0) {
        this.logger.info('No valid boxes to process', { component: 'processor' });
        return result;
      }

      // Create transaction batches
      const batches = this.transactionService.createTransactionBatches(validBoxes);
      
      this.logger.info('Created transaction batches', {
        component: 'processor',
        batchCount: batches.length,
        totalBoxes: validBoxes.length
      });

      // Process each batch
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        
        if (!batch || batch.length === 0) {
          continue;
        }
        
        try {
          const batchResult = await this.processBatch(batch, i + 1, batches.length);
          
          result.processedBoxes += batchResult.processedBoxes;
          result.successfulTransactions += batchResult.successfulTransactions;
          result.failedTransactions += batchResult.failedTransactions;
          result.totalRentCollected += batchResult.totalRentCollected;
          result.totalFeesPaid += batchResult.totalFeesPaid;
          result.errors.push(...batchResult.errors);

          // Add delay between batches to avoid overwhelming the network
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 5000));
          }

        } catch (error) {
          this.logger.error('Batch processing failed', {
            component: 'processor',
            batchIndex: i + 1,
            batchSize: batch.length,
            error: error as Error
          });
          
          result.failedTransactions++;
          result.errors.push(`Batch ${i + 1} failed: ${error}`);
          
          // Mark boxes as error
          for (const box of batch) {
            await this.database.updateBoxStatus(box.boxId, 'error', undefined);
          }
        }
      }

      this.logger.info('Box processing completed', {
        component: 'processor',
        ...result,
        totalRentCollected: result.totalRentCollected.toString(),
        totalFeesPaid: result.totalFeesPaid.toString()
      });

      return result;

    } catch (error) {
      this.logger.error('Box processing failed', {
        component: 'processor',
        error: error as Error
      });
      throw error;
    }
  }

  // Process a single batch of boxes
  private async processBatch(
    boxes: EligibleBox[],
    batchIndex: number,
    totalBatches: number
  ): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processedBoxes: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalRentCollected: 0n,
      totalFeesPaid: 0n,
      errors: []
    };

    try {
      this.logger.info('Processing batch', {
        component: 'processor',
        batchIndex,
        totalBatches,
        batchSize: boxes.length
      });

      const currentHeight = await this.ergoNode.getCurrentHeight();
      const changeAddress = this.transactionService.getWalletAddress();

      // Build transaction using Fleet SDK
      const { unsignedTx, inputBoxes, totalRentCollected } = await this.transactionService.buildStorageRentTransaction(
        boxes,
        changeAddress,
        currentHeight,
        this.ergoNode
      );

      // Validate transaction
      const validation = await this.transactionService.validateTransaction(boxes, unsignedTx);
      if (!validation.valid) {
        throw new Error(`Transaction validation failed: ${validation.errors.join(', ')}`);
      }

      const transactionFee = BigInt(this.config.transactionFee);

      if (this.config.dryRun) {
        this.logger.info('DRY RUN: Would submit transaction', {
          component: 'processor',
          boxCount: boxes.length,
          rentCollected: totalRentCollected.toString(),
          fee: transactionFee.toString()
        });

        // Update result for dry run
        result.processedBoxes = boxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

      } else {
        // Sign and submit transaction using ergo-lib-wasm
        const [txId, signedTxJson] = await this.transactionService.fromUnsigned(unsignedTx);
        
        if (!txId) {
          throw new Error('Failed to sign and submit transaction');
        }
        
        // Create transaction record
        const transactionResult: TransactionResult = {
          txId,
          boxIds: boxes.map(box => box.boxId),
          totalRentCollected,
          transactionFee,
          status: 'pending',
          createdAt: new Date()
        };

        // Save transaction to database
        await this.database.insertTransaction(transactionResult);

        // Update box statuses
        for (const box of boxes) {
          await this.database.updateBoxStatus(box.boxId, 'claimed', txId);
        }

        // Log transaction
        this.logger.info('Storage rent transaction submitted', {
          component: 'processor',
          txId,
          boxIds: boxes.map(box => box.boxId),
          rentCollected: totalRentCollected.toString(),
          fee: transactionFee.toString()
        });

        // Update result
        result.processedBoxes = boxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

        // Monitor transaction confirmation (async)
        this.monitorTransactionConfirmation(txId).catch(error => {
          this.logger.error('Transaction monitoring failed', {
            component: 'processor',
            txId,
            error: error as Error
          });
        });
      }

      return result;

    } catch (error) {
      this.logger.error('Batch processing failed', {
        component: 'processor',
        batchIndex,
        error: error as Error
      });

      result.failedTransactions = 1;
      result.errors.push(`Batch ${batchIndex} failed: ${error}`);
      
      return result;
    }
  }

  // Monitor transaction confirmation
  private async monitorTransactionConfirmation(txId: string): Promise<void> {
    const maxAttempts = 20;
    const checkInterval = 30000; // 30 seconds

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, checkInterval));

        const isConfirmed = await this.ergoNode.isTransactionConfirmed(txId);
        
        if (isConfirmed) {
          await this.database.updateTransactionStatus(txId, 'confirmed');
          this.logger.info('Transaction confirmed', {
            component: 'monitor',
            txId,
            attempts: attempt
          });
          return;
        }

        this.logger.debug('Transaction not yet confirmed', {
          component: 'monitor',
          txId,
          attempt,
          maxAttempts
        });

      } catch (error) {
        this.logger.warn('Transaction confirmation check failed', {
          component: 'monitor',
          txId,
          attempt,
          error: error as Error
        });
      }
    }

    // Mark as failed if not confirmed after max attempts
    await this.database.updateTransactionStatus(txId, 'failed');
    this.logger.warn('Transaction confirmation timeout', {
      component: 'monitor',
      txId,
      maxAttempts
    });
  }

  // Update wallet balance in database
  private async updateWalletBalance(): Promise<void> {
    try {
      const balance = await this.ergoNode.getWalletBalance();
      await this.database.setBotState('wallet_balance', balance.balance.toString());
      
      this.logger.debug('Wallet balance updated', {
        component: 'bot',
        balance: balance.balance.toString()
      });
    } catch (error) {
      this.logger.warn('Failed to update wallet balance', {
        component: 'bot',
        error: error as Error
      });
    }
  }

  // Update bot metrics
  private async updateMetrics(): Promise<void> {
    try {
      const metrics = await this.database.getBotMetrics();
      await this.database.setBotState('last_metrics_update', new Date().toISOString());
      
      this.logger.logMetrics(metrics);
    } catch (error) {
      this.logger.warn('Failed to update metrics', {
        component: 'bot',
        error: error as Error
      });
    }
  }

  // Get current bot status
  async getStatus(): Promise<{
    isRunning: boolean;
    uptime: number;
    metrics: BotMetrics;
    lastScan: Date | null;
    walletAddress: string;
  }> {
    const metrics = await this.database.getBotMetrics();
    const lastScanTime = await this.database.getBotState('last_scan_time');
    
    return {
      isRunning: this.isRunning,
      uptime: Date.now() - this.startTime.getTime(),
      metrics,
      lastScan: lastScanTime ? new Date(lastScanTime) : null,
      walletAddress: this.transactionService.getWalletAddress()
    };
  }


  // Cleanup resources
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up Storage Rent Bot', { component: 'bot' });
    
    await this.stop();
    this.transactionService.cleanup();
    
    this.logger.info('Storage Rent Bot cleanup completed', { component: 'bot' });
  }
} 