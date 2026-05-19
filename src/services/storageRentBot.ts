import * as cron from 'node-cron';
import { Config, EligibleBox, TransactionResult, ProcessingResult, ScanResult, BotMetrics, StorageRentParameters, BroadcastResult } from '../types';
import { ErgoNodeService } from './ergoNode';
import { TransactionService } from './transactionService';
import { Database } from '../database';

type TransactionFinality = {
  confirmed: boolean;
  conflictTxId?: string;
  expired?: boolean;
  timedOut?: boolean;
  currentHeight?: number;
  expiryHeight?: number;
};

type BoxReconciliation = {
  claimed: number;
  requeued: number;
  conflicted: number;
  retired: number;
  pending: number;
};

export class StorageRentBot {
  private config: Config;
  private ergoNode: ErgoNodeService;
  private transactionService: TransactionService;
  private database: Database;
  private isRunning: boolean = false;
  private cronJob: cron.ScheduledTask | null = null;
  private isProcessingCycle: boolean = false;
  private lastQueueScanHeight: number = 0;
  private queuedBoxesByHeight: Map<number, EligibleBox[]> = new Map();
  private lastScanCursor: number = 0;
  private lastNextEligibleLogKey: string | null = null;
  private lastIndexedBehindLogKey: string | null = null;
  private pendingRecoveryComplete: boolean = false;
  private monitoredTransactionIds: Set<string> = new Set();
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
      await this.database.setBotState('storage_rent_mode', this.config.storageRentMode);
      await this.database.setBotState('asset_subsidy_enabled', String(this.config.enableAssetSubsidy));
      await this.database.setBotState('max_asset_subsidy_nanoergs', String(this.config.maxAssetSubsidyNanoErgs));
      await this.database.setBotState('wallet_address', this.getDisplayedWalletAddress());
      if (this.config.storageRentCollectAddress) {
        await this.database.setBotState('storage_rent_collect_address', this.config.storageRentCollectAddress);
      }
      if (this.transactionService.getWalletAddress()) {
        await this.database.setBotState('signing_wallet_address', this.transactionService.getWalletAddress());
      }

      this.logger.info('Storage Rent Bot initialized successfully', {
        component: 'bot',
        storageRentMode: this.config.storageRentMode,
        enableAssetSubsidy: this.config.enableAssetSubsidy,
        maxAssetSubsidyNanoErgs: this.config.maxAssetSubsidyNanoErgs,
        walletAddress: this.getDisplayedWalletAddress(),
        signingWalletAddress: this.transactionService.getWalletAddress()
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
        this.logger.debug('Running scheduled scan', { component: 'cron' });
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
    const emptyResult: ProcessingResult = {
      processedBoxes: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalRentCollected: 0n,
      totalFeesPaid: 0n,
      errors: []
    };

    if (this.isProcessingCycle) {
      this.logger.debug('Scan cycle already running, skipping overlapping tick', { component: 'bot' });
      return emptyResult;
    }

    this.isProcessingCycle = true;

    try {
      const indexedHeight = await this.ergoNode.getCurrentHeight();
      const bestSubmitNode = await this.ergoNode.getBestSubmitNode(true).catch(() => null);
      const currentHeight = Math.max(indexedHeight, bestSubmitNode?.fullHeight ?? 0);
      const rentParams = await this.ergoNode.getStorageRentParameters();
      const spendHeight = currentHeight + 1;

      if (!this.pendingRecoveryComplete) {
        await this.recoverPendingTransactions(rentParams.storagePeriodBlocks);
        this.pendingRecoveryComplete = true;
      }

      if (this.queuedBoxesByHeight.size === 0) {
        const restoredBoxes = await this.restoreQueuedBoxesFromDatabase(currentHeight, spendHeight, rentParams.storagePeriodBlocks);
        if (restoredBoxes > 0) {
          this.lastQueueScanHeight = Math.max(0, currentHeight - 49);
        }
      }

      if (bestSubmitNode && bestSubmitNode.fullHeight > indexedHeight) {
        const logKey = `${indexedHeight}:${bestSubmitNode.fullHeight}:${bestSubmitNode.url}`;
        if (this.lastIndexedBehindLogKey !== logKey) {
          this.lastIndexedBehindLogKey = logKey;
          this.logger.info('Indexed node is behind submit network; using submit height for eligibility', {
            component: 'bot',
            indexedHeight,
            submitHeight: bestSubmitNode.fullHeight,
            submitNode: bestSubmitNode.url
          });
        }
      } else {
        this.lastIndexedBehindLogKey = null;
      }

      // When the queue is empty, scan once per new block so we do not sleep through the next rent boundary.
      const hasQueuedBoxes = this.queuedBoxesByHeight.size > 0;
      const shouldScanQueue = hasQueuedBoxes
        ? currentHeight - this.lastQueueScanHeight >= 50
        : currentHeight > this.lastQueueScanHeight;

      if (shouldScanQueue) {
        this.logger.info('Starting queue scan cycle', { component: 'bot' });

        // Do full scan to find new boxes to queue, organized by height
        const { boxesByHeight, nextOffset } = await this.ergoNode.scanForEligibleBoxes(
          currentHeight,
          rentParams,
          this.lastScanCursor,
          50
        );

        // Merge new boxes into our existing queue by height
        for (const [height, boxes] of boxesByHeight) {
          if (!this.queuedBoxesByHeight.has(height)) {
            this.queuedBoxesByHeight.set(height, []);
          }

          const queuedBoxes = this.queuedBoxesByHeight.get(height)!;
          const queuedBoxIds = new Set(queuedBoxes.map(box => box.boxId));
          for (const box of boxes) {
            const existingBox = await this.database.getBoxById(box.boxId).catch(() => null);
            if (existingBox?.txId && existingBox.status === 'claimed') {
              continue;
            }

            if (existingBox?.txId && existingBox.status === 'pending') {
              continue;
            }

            const existingFailedAssetBox = existingBox?.status === 'error' && existingBox.assets.length > 0;
            if (existingFailedAssetBox || existingBox?.status === 'insufficient_funds') {
              continue;
            }

            await this.database.insertEligibleBox(box);

            if (!queuedBoxIds.has(box.boxId)) {
              queuedBoxes.push(box);
              queuedBoxIds.add(box.boxId);
            }
          }
        }

        this.lastQueueScanHeight = currentHeight;
        this.lastScanCursor = nextOffset;

        const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
        this.logger.info(`Queue scan complete: found ${boxesByHeight.size} height groups with ${totalQueuedBoxes} total boxes queued`, { component: 'bot' });
      }

      // Always check if any queued boxes are now eligible
      this.logger.debug('Checking queued boxes for eligibility', { component: 'bot' });

      const minAge = rentParams.storagePeriodBlocks;
      const cutoffHeight = spendHeight - minAge;

      this.logger.debug(`Checking eligibility: spendHeight=${spendHeight}, minAge=${minAge}, cutoffHeight=${cutoffHeight}`, {
        component: 'processor',
        storageFeeFactor: rentParams.storageFeeFactor,
        minValuePerByte: rentParams.minValuePerByte
      });

      // Find all boxes from heights that are now eligible
      const eligibleGroups: Array<{ height: number; boxes: EligibleBox[] }> = [];
      const heightsToRemove: number[] = [];

      for (const [height, boxes] of this.queuedBoxesByHeight) {
        const eligibleAtHeight = height + minAge;
        const isEligible = spendHeight >= eligibleAtHeight;

        if (isEligible) {
          eligibleGroups.push({ height, boxes });
          heightsToRemove.push(height);
        }
      }

      // Remove processed height groups from queue
      for (const height of heightsToRemove) {
        this.queuedBoxesByHeight.delete(height);
      }

      const nowEligibleCount = eligibleGroups.reduce((sum, group) => sum + group.boxes.length, 0);

      if (nowEligibleCount === 0) {
        // Show detailed info about queued boxes and when they'll be eligible
        if (this.queuedBoxesByHeight.size === 0) {
          this.logger.debug('No boxes in queue - need to perform a queue scan', { component: 'processor' });
        } else {
          // Find the next eligible boxes and show when they'll be ready
          const sortedHeights = Array.from(this.queuedBoxesByHeight.keys()).sort((a, b) => a - b);
          if (sortedHeights.length === 0) {
            return emptyResult;
          }

          const nextEligibleHeight = sortedHeights[0]!; // Safe after length check
          const nextEligibleBoxes = this.queuedBoxesByHeight.get(nextEligibleHeight);
          if (!nextEligibleBoxes) {
            this.logger.warn('No boxes found for next eligible height', { component: 'processor', nextEligibleHeight });
            return emptyResult;
          }

          this.logNextEligibleSummary(
            sortedHeights,
            nextEligibleHeight,
            nextEligibleBoxes,
            currentHeight,
            spendHeight,
            cutoffHeight,
            minAge
          );
        }

        return emptyResult;
      }

      this.lastNextEligibleLogKey = null;
      eligibleGroups.sort((a, b) => b.height - a.height);
      this.logger.info(`Found ${nowEligibleCount} newly eligible boxes from ${eligibleGroups.length} height groups!`, { component: 'processor' });

      // Update wallet balance
      await this.updateWalletBalance();

      const processingResult: ProcessingResult = {
        processedBoxes: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalRentCollected: 0n,
        totalFeesPaid: 0n,
        errors: []
      };

      for (const group of eligibleGroups) {
        this.logger.info('Processing eligible height group', {
          component: 'processor',
          height: group.height,
          boxCount: group.boxes.length
        });

        const groupResult = await this.processEligibleBoxes(group.boxes, currentHeight, rentParams);
        processingResult.processedBoxes += groupResult.processedBoxes;
        processingResult.successfulTransactions += groupResult.successfulTransactions;
        processingResult.failedTransactions += groupResult.failedTransactions;
        processingResult.totalRentCollected += groupResult.totalRentCollected;
        processingResult.totalFeesPaid += groupResult.totalFeesPaid;
        processingResult.errors.push(...groupResult.errors);
      }

      // Update metrics
      await this.updateMetrics();

      const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
      const duration = Date.now() - startTime;
      this.logger.info('Scan and process cycle completed', {
        component: 'bot',
        duration,
        scanned: 0,
        eligible: nowEligibleCount,
        processed: processingResult.processedBoxes,
        successful: processingResult.successfulTransactions,
        failed: processingResult.failedTransactions,
        queued: totalQueuedBoxes,
        queuedHeights: this.queuedBoxesByHeight.size,
        lastScanCursor: this.lastScanCursor
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
    } finally {
      this.isProcessingCycle = false;
    }
  }

  private async restoreQueuedBoxesFromDatabase(
    currentHeight: number,
    spendHeight: number,
    minAge: number
  ): Promise<number> {
    const cutoffHeight = spendHeight - minAge;
    const oldestCreationHeight = cutoffHeight - this.config.scanFutureBlockWindow;
    const newestCreationHeight = cutoffHeight + this.config.scanFutureBlockWindow;
    const queuedBoxes = await this.database.getEligibleBoxes('queued');
    let restoredCount = 0;

    for (const box of queuedBoxes) {
      if (box.creationHeight < oldestCreationHeight || box.creationHeight > newestCreationHeight) {
        continue;
      }

      const spentTxId = await this.ergoNode.getBoxSpentTransactionId(box.boxId).catch(() => null);
      if (spentTxId) {
        continue;
      }

      if (!this.queuedBoxesByHeight.has(box.creationHeight)) {
        this.queuedBoxesByHeight.set(box.creationHeight, []);
      }

      const heightQueue = this.queuedBoxesByHeight.get(box.creationHeight)!;
      if (!heightQueue.some(queuedBox => queuedBox.boxId === box.boxId)) {
        const queuedBox: EligibleBox = { ...box, currentHeight, status: 'queued' };
        delete (queuedBox as any).txId;
        delete (queuedBox as any).claimedAt;
        heightQueue.push(queuedBox);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      this.logger.info('Restored queued boxes from database', {
        component: 'bot',
        restoredCount,
        queuedHeights: this.queuedBoxesByHeight.size
      });
    }

    return restoredCount;
  }

  private async recoverPendingTransactions(minAge: number): Promise<void> {
    const pendingTransactions = await this.database.getTransactions('pending');
    let recoveredCount = 0;

    for (const transaction of pendingTransactions) {
      const boxes = await Promise.all(
        transaction.boxIds.map(boxId => this.database.getBoxById(boxId).catch(() => null))
      );
      const box = boxes.find((item): item is EligibleBox => Boolean(item));
      if (!box) {
        continue;
      }

      this.startTransactionMonitor(
        transaction.txId,
        transaction.boxIds,
        box.creationHeight + minAge
      );
      recoveredCount += 1;
    }

    if (recoveredCount > 0) {
      this.logger.info('Recovered pending transaction monitors', {
        component: 'bot',
        recoveredCount
      });
    }
  }

  private logNextEligibleSummary(
    sortedHeights: number[],
    nextEligibleHeight: number,
    nextEligibleBoxes: EligibleBox[],
    currentHeight: number,
    spendHeight: number,
    cutoffHeight: number,
    minAge: number
  ): void {
    const claimableAtHeight = nextEligibleHeight + minAge;
    const blocksUntilClaimable = claimableAtHeight - spendHeight;
    const totalQueuedBoxes = Array.from(this.queuedBoxesByHeight.values()).reduce((sum, boxes) => sum + boxes.length, 0);
      const logKey = `${nextEligibleHeight}:${nextEligibleBoxes.length}:${blocksUntilClaimable}:${totalQueuedBoxes}`;

    if (this.lastNextEligibleLogKey === logKey) {
      return;
    }

    this.lastNextEligibleLogKey = logKey;

    const nextEligibleBoxIds = nextEligibleBoxes.slice(0, 5).map(box => box.boxId);
    const claimableMessage = blocksUntilClaimable <= 0
      ? 'claimable now'
      : `will be claimable in ${blocksUntilClaimable} blocks (~${Math.round(blocksUntilClaimable * 2)} min)`;
    this.logger.info(`NEXT ELIGIBLE BOXES: ${nextEligibleBoxes.length} boxes at height ${nextEligibleHeight} ${claimableMessage}`, {
      component: 'processor',
      currentHeight,
      spendHeight,
      cutoffHeight,
      totalQueuedBoxes,
      nextEligibleHeight,
      claimableAtHeight,
      blocksUntilClaimable,
      nextEligibleCount: nextEligibleBoxes.length,
      nextEligibleBoxIds,
      estimatedTimeMinutes: Math.max(Math.round(blocksUntilClaimable * 2), 0) // ~2 minutes per block
    });

    this.logger.info(`Next eligible box IDs: ${nextEligibleBoxIds.join(', ')}${nextEligibleBoxes.length > 5 ? ` ...and ${nextEligibleBoxes.length - 5} more` : ''}`, { component: 'processor' });

    this.logger.info('Queued boxes summary by height:', { component: 'processor' });
    for (const height of sortedHeights.slice(0, 5)) {
      const boxes = this.queuedBoxesByHeight.get(height)!;
      const claimableAt = height + minAge;
      const blocksUntil = claimableAt - spendHeight;
      const summary = blocksUntil <= 0 ? 'eligible now' : `eligible in ${blocksUntil} blocks`;
      this.logger.info(`  Height ${height}: ${boxes.length} boxes -> ${summary}`, { component: 'processor' });
    }
  }


  // Process eligible boxes by creating and submitting transactions
  private async processEligibleBoxes(
    eligibleBoxes: EligibleBox[],
    currentHeight: number,
    rentParams: StorageRentParameters
  ): Promise<ProcessingResult> {
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

      const cachedBoxes = eligibleBoxes.filter(box => box.boxData);
      const uncachedBoxes = eligibleBoxes.filter(box => !box.boxData);
      const uncachedBoxIds = uncachedBoxes.map(box => box.boxId);
      const validation = uncachedBoxIds.length > 0
        ? await this.ergoNode.validateBoxes(uncachedBoxIds, currentHeight, rentParams)
        : { valid: [], invalid: [] };

      // Update invalid boxes in database
      for (const invalidBoxId of validation.invalid) {
        await this.database.updateBoxStatus(invalidBoxId, 'error', undefined);
      }

      // Filter to only valid boxes
      const validUncachedBoxIds = new Set(validation.valid);
      const validBoxes = [
        ...cachedBoxes,
        ...uncachedBoxes.filter(box => validUncachedBoxIds.has(box.boxId))
      ];

      if (cachedBoxes.length > 0) {
        this.logger.info('Using cached scan box payloads for transaction build', {
          component: 'processor',
          cachedBoxes: cachedBoxes.length,
          remoteValidatedBoxes: uncachedBoxes.length
        });
      }

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
          const batchResult = await this.processBatch(batch, i + 1, batches.length, rentParams);

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
    totalBatches: number,
    rentParams: StorageRentParameters
  ): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      processedBoxes: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalRentCollected: 0n,
      totalFeesPaid: 0n,
      errors: []
    };

    let batchBoxes = boxes;

    try {
      this.logger.info('Processing batch', {
        component: 'processor',
        batchIndex,
        totalBatches,
        batchSize: batchBoxes.length
      });

      const changeAddress = this.transactionService.getWalletAddress();
      const buildTransactionAtHeight = async (height: number) => {
        const builtTransaction = await this.transactionService.buildStorageRentTransaction(
          batchBoxes,
          changeAddress,
          height,
          this.ergoNode,
          rentParams
        );

        const validation = await this.transactionService.validateTransaction(batchBoxes, builtTransaction.unsignedTx);
        if (!validation.valid) {
          throw new Error(`Transaction validation failed: ${validation.errors.join(', ')}`);
        }

        return builtTransaction;
      };

      let submitNode = this.config.dryRun ? null : await this.ergoNode.getBestSubmitNode(true);
      let buildHeight = submitNode?.fullHeight ?? await this.ergoNode.getPrimarySubmitHeight();
      if (submitNode) {
        const liveValidation = await this.ergoNode.validateBoxesOnNode(
          submitNode.url,
          batchBoxes.map(box => box.boxId),
          buildHeight,
          rentParams
        );

        for (const invalidBoxId of liveValidation.invalid) {
          await this.database.updateBoxStatus(invalidBoxId, 'error', undefined);
        }

        if (liveValidation.invalid.length > 0) {
          this.logger.warn('Submit node UTXO check removed unavailable boxes from batch', {
            component: 'processor',
            batchIndex,
            submitNode: submitNode.url,
            submitNodeHeight: buildHeight,
            validBoxes: liveValidation.valid.length,
            invalidBoxes: liveValidation.invalid.length
          });
        }

        const validBoxIds = new Set(liveValidation.valid);
        batchBoxes = batchBoxes.filter(box => validBoxIds.has(box.boxId));
        if (batchBoxes.length === 0) {
          this.logger.info('No live UTXO boxes left in batch after submit-node check', {
            component: 'processor',
            batchIndex,
            submitNode: submitNode.url,
            submitNodeHeight: buildHeight
          });
          return result;
        }
      }

      let {
        unsignedTx,
        inputBoxes,
        walletInputIndexes,
        walletSubsidy,
        totalRentCollected,
        minerFee,
        collectorValue,
        collectorTokenCount
      } = await buildTransactionAtHeight(buildHeight);
      let transactionFee = minerFee;

      if (this.config.dryRun) {
	        this.logger.info('DRY RUN: Would submit transaction', {
          component: 'processor',
	          boxCount: batchBoxes.length,
		          rentCollected: totalRentCollected.toString(),
		          fee: transactionFee.toString(),
		          collectorValue: collectorValue.toString(),
              walletSubsidy: walletSubsidy.toString(),
		          collectorTokenCount
		        });

        // Update result for dry run
        result.processedBoxes = batchBoxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

      } else {
        if (!submitNode) {
		          submitNode = await this.ergoNode.getBestSubmitNode(true);
		          buildHeight = submitNode.fullHeight;
		          ({
                unsignedTx,
                inputBoxes,
                walletInputIndexes,
                walletSubsidy,
                totalRentCollected,
                minerFee,
                collectorValue,
                collectorTokenCount
              } = await buildTransactionAtHeight(buildHeight));
		          transactionFee = minerFee;
		        }

	        let { txId, signedTx } = await this.transactionService.createSignedStorageRentTransaction(
            unsignedTx,
            inputBoxes,
            walletInputIndexes
          );
        const refreshedSubmitNode = await this.ergoNode.getBestSubmitNode(true);
        if (refreshedSubmitNode.fullHeight !== buildHeight) {
          this.logger.info('Submit node height changed while building transaction; rebuilding before submit', {
            component: 'processor',
            previousBuildHeight: buildHeight,
            submitNodeHeight: refreshedSubmitNode.fullHeight,
            submitNode: refreshedSubmitNode.url,
            batchIndex,
            batchSize: batchBoxes.length
          });

	          submitNode = refreshedSubmitNode;
	          buildHeight = submitNode.fullHeight;
          const liveValidation = await this.ergoNode.validateBoxesOnNode(
            submitNode.url,
            batchBoxes.map(box => box.boxId),
            buildHeight,
            rentParams
          );

          for (const invalidBoxId of liveValidation.invalid) {
            await this.database.updateBoxStatus(invalidBoxId, 'error', undefined);
          }

          if (liveValidation.invalid.length > 0) {
            this.logger.warn('Submit node UTXO check removed unavailable boxes before rebuild', {
              component: 'processor',
              batchIndex,
              submitNode: submitNode.url,
              submitNodeHeight: buildHeight,
              validBoxes: liveValidation.valid.length,
              invalidBoxes: liveValidation.invalid.length
            });
          }

          const validBoxIds = new Set(liveValidation.valid);
          batchBoxes = batchBoxes.filter(box => validBoxIds.has(box.boxId));
          if (batchBoxes.length === 0) {
            this.logger.info('No live UTXO boxes left in batch after submit-node height refresh', {
              component: 'processor',
              batchIndex,
              submitNode: submitNode.url,
              submitNodeHeight: buildHeight
            });
            return result;
          }

		          ({
                unsignedTx,
                inputBoxes,
                walletInputIndexes,
                walletSubsidy,
                totalRentCollected,
                minerFee,
                collectorValue,
                collectorTokenCount
              } = await buildTransactionAtHeight(buildHeight));
		          transactionFee = minerFee;
		          ({ txId, signedTx } = await this.transactionService.createSignedStorageRentTransaction(
                unsignedTx,
                inputBoxes,
                walletInputIndexes
              ));
        } else {
          submitNode = refreshedSubmitNode;
        }

        let primarySubmitId: string | null = null;
        let primaryAccepted = false;
        let primaryRejectReason: string | null = null;
        let broadcastResult: BroadcastResult = { attempted: 0, accepted: [], rejected: [] };

        try {
          const primaryResult = await this.ergoNode.submitTransactionToNode(submitNode.url, signedTx, txId);
          if (!primaryResult.accepted || !primaryResult.txId) {
            throw new Error(`Failed to submit transaction: ${primaryResult.error || 'unknown error'}`);
          }

          primarySubmitId = primaryResult.txId;
          primaryAccepted = true;
          if (primarySubmitId !== txId) {
            this.logger.warn('Primary node returned unexpected tx id', {
              component: 'processor',
              txId,
              returnedTxId: primarySubmitId
            });
          }
        } catch (error) {
          primaryRejectReason = error instanceof Error ? error.message : String(error);

          if (!this.isMempoolDoubleSpend(primaryRejectReason)) {
            this.logger.warn('Primary node rejected transaction; skipping broadcast', {
              component: 'processor',
              txId,
              primaryNode: submitNode.url,
              submitNodeHeight: buildHeight,
              error: error as Error
            });
            throw new Error(`Primary node rejected transaction: ${primaryRejectReason}`);
          }

          this.logger.warn('Primary node has mempool conflict; trying alternate submit nodes', {
            component: 'processor',
            txId,
            primaryNode: submitNode.url,
            submitNodeHeight: buildHeight,
            primaryRejectReason
          });

          broadcastResult = await this.ergoNode.broadcastTransaction(
            signedTx,
            [submitNode.url],
            buildHeight,
            txId
          );

          if (broadcastResult.accepted.length === 0) {
            throw new Error(
              `Primary node rejected double spend and no alternate node accepted transaction: ${primaryRejectReason}`
            );
          }
        }

        if (primaryAccepted && this.config.confirmPrimaryBeforeBroadcast) {
          const finality = await this.waitForTransactionFinality(txId, batchBoxes.map(box => box.boxId), buildHeight + 1);
          if (!finality.confirmed) {
            throw new Error(finality.conflictTxId
              ? `Primary transaction lost storage-rent race to ${finality.conflictTxId}`
              : 'Primary transaction was not confirmed before broadcast');
          }
        }

        if (primaryAccepted) {
          broadcastResult = await this.ergoNode.broadcastTransaction(
            signedTx,
            [submitNode.url],
            buildHeight,
            txId
          );
        }

        // Create transaction record
        const transactionResult: TransactionResult = {
          txId,
          boxIds: batchBoxes.map(box => box.boxId),
          totalRentCollected,
          transactionFee,
          status: 'pending',
          createdAt: new Date()
        };

        // Save transaction to database
        await this.database.insertTransaction(transactionResult);

        // Broadcast acceptance is not confirmation. Keep boxes pending until chain monitoring proves our tx won.
        for (const box of batchBoxes) {
          await this.database.updateBoxStatus(box.boxId, 'pending', txId);
        }

        // Log transaction
        this.logger.info('Storage rent transaction submitted', {
          component: 'processor',
          txId,
          boxIds: batchBoxes.map(box => box.boxId),
	          rentCollected: totalRentCollected.toString(),
	          fee: transactionFee.toString(),
		          collectorValue: collectorValue.toString(),
              walletSubsidy: walletSubsidy.toString(),
		          collectorTokenCount,
	          primaryAccepted,
          primaryNode: submitNode.url,
          submitNodeHeight: buildHeight,
          primaryRejectReason,
          broadcastAttempted: broadcastResult.attempted,
          broadcastAccepted: broadcastResult.accepted.length,
          broadcastRejected: broadcastResult.rejected.length
        });

        // Update result
        result.processedBoxes = batchBoxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

        this.startTransactionMonitor(txId, batchBoxes.map(box => box.boxId), buildHeight + 1);
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
      const retryUnspentBoxes = !this.isNonRetryableBatchError(error);

      const reconciliation = await this.reconcileUnconfirmedBoxes(
        batchBoxes.map(box => box.boxId),
        '',
        { requeueUnspent: retryUnspentBoxes }
      );
      if (reconciliation.requeued > 0 || reconciliation.retired > 0) {
        this.logger.warn(retryUnspentBoxes
          ? 'Batch failed; requeued unspent boxes'
          : 'Batch failed with non-retryable validation error; retired unspent boxes', {
          component: 'processor',
          batchIndex,
          requeued: reconciliation.requeued,
          retired: reconciliation.retired,
          conflicted: reconciliation.conflicted,
          claimed: reconciliation.claimed
        });
      }

      return result;
    }
  }

  private startTransactionMonitor(txId: string, boxIds: string[], txSpendHeight: number): void {
    if (this.monitoredTransactionIds.has(txId)) {
      return;
    }

    this.monitoredTransactionIds.add(txId);
    this.monitorTransactionConfirmation(txId, boxIds, txSpendHeight)
      .catch(error => {
        this.logger.error('Transaction monitoring failed', {
          component: 'processor',
          txId,
          error: error as Error
        });
      })
      .finally(() => {
        this.monitoredTransactionIds.delete(txId);
      });
  }

  // Monitor transaction confirmation
  private async monitorTransactionConfirmation(txId: string, boxIds: string[], txSpendHeight: number): Promise<void> {
    const finality: TransactionFinality = await this.waitForTransactionFinality(txId, boxIds, txSpendHeight).catch(error => {
      this.logger.warn('Transaction confirmation wait failed', {
        component: 'monitor',
        txId,
        error: error as Error
      });
      return { confirmed: false };
    });

    if (finality.confirmed) {
      await this.database.updateTransactionStatus(txId, 'confirmed');
      for (const boxId of boxIds) {
        await this.database.updateBoxStatus(boxId, 'claimed', txId);
      }

      this.logger.info('Transaction confirmed', {
        component: 'monitor',
        txId
      });
      return;
    }

    const reconciliation = await this.reconcileUnconfirmedBoxes(boxIds, txId, {
      requeueUnspent: !finality.conflictTxId,
      keepUnspentPending: !finality.expired && !finality.conflictTxId
    });

    if (reconciliation.claimed === boxIds.length) {
      await this.database.updateTransactionStatus(txId, 'confirmed');
      this.logger.info('Transaction confirmed from spent box records', {
        component: 'monitor',
        txId
      });
      return;
    }

    if (!finality.expired && !finality.conflictTxId && reconciliation.conflicted === 0) {
      this.logger.warn('Transaction still pending; keeping boxes pending', {
        component: 'monitor',
        txId,
        txSpendHeight,
        currentHeight: finality.currentHeight,
        expiryHeight: finality.expiryHeight,
        pending: reconciliation.pending,
        claimed: reconciliation.claimed,
        timedOut: Boolean(finality.timedOut)
      });

      if (this.isRunning) {
        const retryDelay = Math.max(this.config.transactionFinalityCheckMs, 30000);
        const retryTimer = setTimeout(() => {
          if (this.isRunning) {
            this.startTransactionMonitor(txId, boxIds, txSpendHeight);
          }
        }, retryDelay);
        retryTimer.unref?.();
      }

      return;
    }

    await this.database.updateTransactionStatus(txId, 'failed');

    const conflictTxId = finality.conflictTxId;
    if (conflictTxId || reconciliation.conflicted > 0) {
      this.logger.warn('Transaction lost storage-rent race', {
        component: 'monitor',
        txId,
        conflictTxId,
        retired: reconciliation.retired,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });
      return;
    }

    if (reconciliation.requeued > 0) {
      this.logger.warn('Transaction not confirmed after grace window; requeued unspent boxes', {
        component: 'monitor',
        txId,
        txSpendHeight,
        currentHeight: finality.currentHeight,
        expiryHeight: finality.expiryHeight,
        requeued: reconciliation.requeued,
        retired: reconciliation.retired,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });
      return;
    }

    if (reconciliation.retired > 0) {
      this.logger.warn('Transaction retired unavailable boxes', {
        component: 'monitor',
        txId,
        txSpendHeight,
        currentHeight: finality.currentHeight,
        expiryHeight: finality.expiryHeight,
        retired: reconciliation.retired,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });
      return;
    }

    this.logger.warn('Transaction confirmation timeout', {
      component: 'monitor',
      txId,
      conflicted: reconciliation.conflicted,
      claimed: reconciliation.claimed
    });
  }

  private async reconcileUnconfirmedBoxes(
    boxIds: string[],
    txId: string,
    options: { requeueUnspent?: boolean; keepUnspentPending?: boolean } = {}
  ): Promise<BoxReconciliation> {
    const result: BoxReconciliation = { claimed: 0, requeued: 0, conflicted: 0, retired: 0, pending: 0 };
    const requeueUnspent = options.requeueUnspent ?? true;
    const keepUnspentPending = options.keepUnspentPending ?? false;

    for (const boxId of boxIds) {
      const spentTxId = await this.ergoNode.getBoxSpentTransactionId(boxId).catch(() => null);
      if (spentTxId) {
        if (spentTxId === txId) {
          await this.database.updateBoxStatus(boxId, 'claimed', txId);
          result.claimed += 1;
        } else {
          await this.database.updateBoxStatus(boxId, 'error', txId);
          result.conflicted += 1;
        }

        continue;
      }

      const box = await this.database.getBoxById(boxId).catch(() => null);
      if (!box) {
        continue;
      }

      if (keepUnspentPending) {
        await this.database.updateBoxStatus(boxId, 'pending', txId || box.txId);
        result.pending += 1;
        continue;
      }

      if (!requeueUnspent) {
        await this.database.updateBoxStatus(boxId, 'error', txId || undefined);
        result.retired += 1;
        continue;
      }

      await this.database.updateBoxStatus(boxId, 'queued', undefined);
      result.requeued += 1;

      if (!this.queuedBoxesByHeight.has(box.creationHeight)) {
        this.queuedBoxesByHeight.set(box.creationHeight, []);
      }

      const queuedBoxes = this.queuedBoxesByHeight.get(box.creationHeight)!;
      if (!queuedBoxes.some(queuedBox => queuedBox.boxId === boxId)) {
        const queuedBox: EligibleBox = { ...box, status: 'queued' };
        delete (queuedBox as any).txId;
        delete (queuedBox as any).claimedAt;
        queuedBoxes.push(queuedBox);
      }
    }

    return result;
  }

  private isMempoolDoubleSpend(errorMessage: string): boolean {
    return errorMessage.toLowerCase().includes('double spending');
  }

  private isNonRetryableBatchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    return lowerMessage.includes('scripts of all transaction inputs should pass verification') ||
      lowerMessage.includes('success((false') ||
      lowerMessage.includes('asset boxes need recreation or an external subsidy input') ||
      lowerMessage.includes('underfunded boxes need an external subsidy input') ||
      lowerMessage.includes('asset collection needs') ||
      lowerMessage.includes('asset subsidy') ||
      lowerMessage.includes('wallet has no pure erg utxo') ||
      lowerMessage.includes('cannot pay positive storage rent') ||
      lowerMessage.includes('no positive miner fee');
  }

  private async waitForTransactionFinality(txId: string, boxIds: string[], txSpendHeight: number): Promise<TransactionFinality> {
    const checkInterval = this.config.transactionFinalityCheckMs;
    const expiryHeight = txSpendHeight + this.config.transactionFinalityGraceBlocks;
    const checksPerSlowBlock = Math.max(1, Math.ceil(180000 / checkInterval));
    const maxAttempts = Math.max(12, (this.config.transactionFinalityGraceBlocks + 2) * checksPerSlowBlock);
    let lastKnownHeight: number | undefined;
    let lastExplorerCheckHeight: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      const currentSubmitHeight = await this.ergoNode.getPrimarySubmitHeight()
        .catch(() => this.ergoNode.getCurrentHeight());
      lastKnownHeight = currentSubmitHeight;

      const includeExplorer = currentSubmitHeight >= txSpendHeight && currentSubmitHeight !== lastExplorerCheckHeight;
      if (includeExplorer) {
        lastExplorerCheckHeight = currentSubmitHeight;
      }

      const isConfirmed = await this.ergoNode.isTransactionConfirmed(txId, { includeExplorer }).catch(error => {
        this.logger.warn('Transaction confirmation endpoint failed', {
          component: 'monitor',
          txId,
          attempt,
          error: error as Error
        });
        return false;
      });

      if (isConfirmed) {
        return { confirmed: true };
      }

      const spentTransactionIds = await Promise.all(
        boxIds.map(boxId => this.ergoNode.getBoxSpentTransactionId(boxId, { includeExplorer }).catch(error => {
          this.logger.warn('Box spent check failed', {
            component: 'monitor',
            txId,
            boxId,
            attempt,
            error: error as Error
          });
          return null;
        }))
      );

      const knownSpentTxIds = spentTransactionIds.filter((spentTxId): spentTxId is string => Boolean(spentTxId));
      if (knownSpentTxIds.length === boxIds.length && knownSpentTxIds.every(spentTxId => spentTxId === txId)) {
        return { confirmed: true };
      }

      const conflictTxId = knownSpentTxIds.find(spentTxId => spentTxId !== txId);
      if (conflictTxId) {
        return { confirmed: false, conflictTxId };
      }

      if (currentSubmitHeight >= expiryHeight) {
        return { confirmed: false, expired: true, currentHeight: currentSubmitHeight, expiryHeight };
      }

      this.logger.debug('Transaction not yet confirmed', {
        component: 'monitor',
        txId,
        attempt,
        maxAttempts,
        currentHeight: currentSubmitHeight,
        txSpendHeight,
        expiryHeight,
        includeExplorer
      });
    }

    return {
      confirmed: false,
      timedOut: true,
      expiryHeight,
      ...(lastKnownHeight !== undefined && { currentHeight: lastKnownHeight })
    };
  }

  // Update wallet balance in database
  private async updateWalletBalance(): Promise<void> {
    try {
      const balanceAddress = this.getDisplayedWalletAddress();
      if (!balanceAddress) {
        return;
      }

      const balance = await this.ergoNode.getWalletBalance(balanceAddress);
      await this.database.setBotState('wallet_balance', balance.balance.toString());
      await this.database.setBotState('wallet_balance_address', balanceAddress);

      this.logger.debug('Wallet balance updated', {
        component: 'bot',
        balanceAddress,
        balance: balance.balance.toString()
      });
    } catch (error) {
      this.logger.warn('Failed to update wallet balance', {
        component: 'bot',
        error: error as Error
      });
    }
  }

  private getDisplayedWalletAddress(): string {
    return this.config.storageRentCollectAddress || this.transactionService.getWalletAddress();
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
