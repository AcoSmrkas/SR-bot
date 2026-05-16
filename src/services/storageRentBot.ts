import * as cron from 'node-cron';
import { Config, EligibleBox, TransactionResult, ProcessingResult, ScanResult, BotMetrics, StorageRentParameters, BroadcastResult } from '../types';
import { ErgoNodeService } from './ergoNode';
import { TransactionService } from './transactionService';
import { Database } from '../database';

type TransactionFinality = {
  confirmed: boolean;
  conflictTxId?: string;
  expired?: boolean;
};

type BoxReconciliation = {
  claimed: number;
  requeued: number;
  conflicted: number;
  retired: number;
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

      if (this.queuedBoxesByHeight.size === 0) {
        const restoredBoxes = await this.restoreQueuedBoxesFromDatabase(currentHeight, spendHeight, rentParams.storagePeriodBlocks);
        if (restoredBoxes > 0) {
          this.lastQueueScanHeight = Math.max(0, currentHeight - 49);
        }
      }

      if (bestSubmitNode && bestSubmitNode.fullHeight > indexedHeight) {
        this.logger.info('Indexed node is behind submit network; using submit height for eligibility', {
          component: 'bot',
          indexedHeight,
          submitHeight: bestSubmitNode.fullHeight,
          submitNode: bestSubmitNode.url
        });
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
          const claimableAtHeight = height + rentParams.storagePeriodBlocks;
          if (claimableAtHeight < spendHeight) {
            this.logger.debug('Skipping stale scanned storage-rent height group', {
              component: 'bot',
              height,
              boxCount: boxes.length,
              claimableAtHeight,
              spendHeight
            });
            continue;
          }

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
              const pendingBoxCanBeRetried = spendHeight === existingBox.creationHeight + rentParams.storagePeriodBlocks;
              if (!pendingBoxCanBeRetried) {
                continue;
              }

              await this.database.updateBoxStatus(box.boxId, 'queued', undefined);
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
      const staleGroups: Array<{ height: number; boxes: EligibleBox[]; missedByBlocks: number }> = [];
      const heightsToRemove: number[] = [];

      for (const [height, boxes] of this.queuedBoxesByHeight) {
        const eligibleAtHeight = height + minAge;
        const isEligible = spendHeight === eligibleAtHeight; // Claim in the next block that can include it.
        const isStale = spendHeight > eligibleAtHeight;

        if (isEligible) {
          eligibleGroups.push({ height, boxes });
          heightsToRemove.push(height);
        } else if (isStale) {
          staleGroups.push({ height, boxes, missedByBlocks: spendHeight - eligibleAtHeight });
          heightsToRemove.push(height);
        }
      }

      // Remove processed height groups from queue
      for (const height of heightsToRemove) {
        this.queuedBoxesByHeight.delete(height);
      }

      for (const group of staleGroups) {
        const reconciliation = await this.reconcileUnconfirmedBoxes(
          group.boxes.map(box => box.boxId),
          '',
          { requeueUnspent: false }
        );

        this.logger.warn('Retired stale storage-rent height group from queue', {
          component: 'processor',
          height: group.height,
          boxCount: group.boxes.length,
          missedByBlocks: group.missedByBlocks,
          claimed: reconciliation.claimed,
          conflicted: reconciliation.conflicted,
          retired: reconciliation.retired
        });
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
    const queuedBoxes = [
      ...await this.database.getEligibleBoxes('queued'),
      ...await this.database.getEligibleBoxes('pending')
    ];
    let restoredCount = 0;
    let retiredStaleCount = 0;

    for (const box of queuedBoxes) {
      if (box.creationHeight < oldestCreationHeight || box.creationHeight > newestCreationHeight) {
        continue;
      }

      const claimableAtHeight = box.creationHeight + minAge;
      if (claimableAtHeight < spendHeight) {
        const reconciliation = await this.reconcileUnconfirmedBoxes([box.boxId], box.txId ?? '', { requeueUnspent: false });
        retiredStaleCount += reconciliation.claimed + reconciliation.conflicted + reconciliation.retired;
        continue;
      }

      const spentTxId = await this.ergoNode.getBoxSpentTransactionId(box.boxId).catch(() => null);
      if (spentTxId) {
        continue;
      }

      if (box.status === 'pending') {
        await this.database.updateBoxStatus(box.boxId, 'queued', undefined);
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

    if (retiredStaleCount > 0) {
      this.logger.info('Retired stale queued boxes from database', {
        component: 'bot',
        retiredStaleCount
      });
    }

    return restoredCount;
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
    this.logger.info(`NEXT ELIGIBLE BOXES: ${nextEligibleBoxes.length} boxes at height ${nextEligibleHeight} will be claimable in ${blocksUntilClaimable} blocks (~${Math.round(blocksUntilClaimable * 2)} min)`, {
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
      estimatedTimeMinutes: Math.round(blocksUntilClaimable * 2) // ~2 minutes per block
    });

    this.logger.info(`Next eligible box IDs: ${nextEligibleBoxIds.join(', ')}${nextEligibleBoxes.length > 5 ? ` ...and ${nextEligibleBoxes.length - 5} more` : ''}`, { component: 'processor' });

    this.logger.info('Queued boxes summary by height:', { component: 'processor' });
    for (const height of sortedHeights.slice(0, 5)) {
      const boxes = this.queuedBoxesByHeight.get(height)!;
      const claimableAt = height + minAge;
      const blocksUntil = claimableAt - spendHeight;
      this.logger.info(`  Height ${height}: ${boxes.length} boxes -> eligible in ${blocksUntil} blocks`, { component: 'processor' });
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

      // Validate the passed eligible boxes are still unspent
      const boxIds = eligibleBoxes.map(box => box.boxId);
      const validation = await this.ergoNode.validateBoxes(boxIds, currentHeight, rentParams);

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

    try {
      this.logger.info('Processing batch', {
        component: 'processor',
        batchIndex,
        totalBatches,
        batchSize: boxes.length
      });

      const changeAddress = this.transactionService.getWalletAddress();
      const buildTransactionAtHeight = async (height: number) => {
        const builtTransaction = await this.transactionService.buildStorageRentTransaction(
          boxes,
          changeAddress,
          height,
          this.ergoNode,
          rentParams
        );

        const validation = await this.transactionService.validateTransaction(boxes, builtTransaction.unsignedTx);
        if (!validation.valid) {
          throw new Error(`Transaction validation failed: ${validation.errors.join(', ')}`);
        }

        return builtTransaction;
      };

      let submitNode = this.config.dryRun ? null : await this.ergoNode.getBestSubmitNode(true);
      let buildHeight = submitNode?.fullHeight ?? await this.ergoNode.getPrimarySubmitHeight();
      let { unsignedTx, totalRentCollected, minerFee, collectorValue, collectorTokenCount } = await buildTransactionAtHeight(buildHeight);
      let transactionFee = minerFee;

      if (this.config.dryRun) {
        this.logger.info('DRY RUN: Would submit transaction', {
          component: 'processor',
	          boxCount: boxes.length,
	          rentCollected: totalRentCollected.toString(),
	          fee: transactionFee.toString(),
	          collectorValue: collectorValue.toString(),
	          collectorTokenCount
	        });

        // Update result for dry run
        result.processedBoxes = boxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

      } else {
        if (!submitNode) {
	          submitNode = await this.ergoNode.getBestSubmitNode(true);
	          buildHeight = submitNode.fullHeight;
	          ({ unsignedTx, totalRentCollected, minerFee, collectorValue, collectorTokenCount } = await buildTransactionAtHeight(buildHeight));
	          transactionFee = minerFee;
	        }

        let { txId, signedTx } = this.transactionService.createSignedStorageRentTransaction(unsignedTx);
        const refreshedSubmitNode = await this.ergoNode.getBestSubmitNode(true);
        if (refreshedSubmitNode.fullHeight !== buildHeight) {
          this.logger.info('Submit node height changed while building transaction; rebuilding before submit', {
            component: 'processor',
            previousBuildHeight: buildHeight,
            submitNodeHeight: refreshedSubmitNode.fullHeight,
            submitNode: refreshedSubmitNode.url,
            batchIndex,
            batchSize: boxes.length
          });

	          submitNode = refreshedSubmitNode;
	          buildHeight = submitNode.fullHeight;
	          ({ unsignedTx, totalRentCollected, minerFee, collectorValue, collectorTokenCount } = await buildTransactionAtHeight(buildHeight));
	          transactionFee = minerFee;
	          ({ txId, signedTx } = this.transactionService.createSignedStorageRentTransaction(unsignedTx));
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
          const finality = await this.waitForTransactionFinality(txId, boxes.map(box => box.boxId), buildHeight + 1);
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
          boxIds: boxes.map(box => box.boxId),
          totalRentCollected,
          transactionFee,
          status: 'pending',
          createdAt: new Date()
        };

        // Save transaction to database
        await this.database.insertTransaction(transactionResult);

        // Broadcast acceptance is not confirmation. Keep boxes pending until chain monitoring proves our tx won.
        for (const box of boxes) {
          await this.database.updateBoxStatus(box.boxId, 'pending', txId);
        }

        // Log transaction
        this.logger.info('Storage rent transaction submitted', {
          component: 'processor',
          txId,
	          boxIds: boxes.map(box => box.boxId),
	          rentCollected: totalRentCollected.toString(),
	          fee: transactionFee.toString(),
	          collectorValue: collectorValue.toString(),
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
        result.processedBoxes = boxes.length;
        result.successfulTransactions = 1;
        result.totalRentCollected = totalRentCollected;
        result.totalFeesPaid = transactionFee;

        // Monitor transaction confirmation (async)
        this.monitorTransactionConfirmation(txId, boxes.map(box => box.boxId), buildHeight + 1).catch(error => {
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

      const errorMessage = error instanceof Error ? error.message : String(error);
      const reconciliation = await this.reconcileUnconfirmedBoxes(
        boxes.map(box => box.boxId),
        '',
        { requeueUnspent: !this.isMempoolDoubleSpend(errorMessage) }
      );
      if (reconciliation.requeued > 0 || reconciliation.retired > 0) {
        this.logger.warn(reconciliation.requeued > 0
          ? 'Batch failed; requeued unspent boxes'
          : 'Batch failed from mempool conflict; retired unspent boxes', {
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
      requeueUnspent: !finality.expired
    });

    if (reconciliation.claimed === boxIds.length) {
      await this.database.updateTransactionStatus(txId, 'confirmed');
      this.logger.info('Transaction confirmed from spent box records', {
        component: 'monitor',
        txId
      });
      return;
    }

    await this.database.updateTransactionStatus(txId, 'failed');

    if (reconciliation.requeued > 0) {
      this.logger.warn('Transaction unresolved; requeued unspent boxes', {
        component: 'monitor',
        txId,
        txSpendHeight,
        requeued: reconciliation.requeued,
        retired: reconciliation.retired,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });

      this.runScanAndProcess().catch(error => {
        this.logger.error('Immediate retry after unconfirmed transaction failed', {
          component: 'monitor',
          txId,
          error: error as Error
        });
      });
      return;
    }

    if (reconciliation.retired > 0) {
      this.logger.warn('Transaction missed its storage-rent height; retired unspent boxes', {
        component: 'monitor',
        txId,
        txSpendHeight,
        retired: reconciliation.retired,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });
      return;
    }

    const conflictTxId = finality.conflictTxId;
    if (conflictTxId) {
      this.logger.warn('Transaction lost storage-rent race', {
        component: 'monitor',
        txId,
        conflictTxId,
        conflicted: reconciliation.conflicted
      });
    } else {
      this.logger.warn('Transaction confirmation timeout', {
        component: 'monitor',
        txId,
        conflicted: reconciliation.conflicted,
        claimed: reconciliation.claimed
      });
    }
  }

  private async reconcileUnconfirmedBoxes(
    boxIds: string[],
    txId: string,
    options: { requeueUnspent?: boolean } = {}
  ): Promise<BoxReconciliation> {
    const result: BoxReconciliation = { claimed: 0, requeued: 0, conflicted: 0, retired: 0 };
    const requeueUnspent = options.requeueUnspent ?? true;

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

  private async waitForTransactionFinality(txId: string, boxIds: string[], txSpendHeight: number): Promise<TransactionFinality> {
    const maxAttempts = 12;
    const checkInterval = 10000; // 10 seconds

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));

      const isConfirmed = await this.ergoNode.isTransactionConfirmed(txId).catch(error => {
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
        boxIds.map(boxId => this.ergoNode.getBoxSpentTransactionId(boxId).catch(error => {
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

      const currentSubmitHeight = await this.ergoNode.getBestSubmitNode(true)
        .then(node => node.fullHeight)
        .catch(() => this.ergoNode.getCurrentHeight());
      if (currentSubmitHeight >= txSpendHeight) {
        return { confirmed: false, expired: true };
      }

      this.logger.debug('Transaction not yet confirmed', {
        component: 'monitor',
        txId,
        attempt,
        maxAttempts
      });
    }

    return { confirmed: false };
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
