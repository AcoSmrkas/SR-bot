import axios, { AxiosInstance } from 'axios';
import { estimateBoxSize } from '@fleet-sdk/serializer';
import { Config, NodeInfo, BoxData, EligibleBox } from '../types';

export class ErgoNodeService {
  private client: AxiosInstance;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Add API key if provided
    if (config.ergoNodeApiKey) {
      headers['api_key'] = config.ergoNodeApiKey;
    }
    
    this.client = axios.create({
      baseURL: config.ergoNodeUrl,
      timeout: 10000,
      headers,
    });
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/info');
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  // Get current blockchain height
  async getCurrentHeight(): Promise<number> {
    try {
      const response = await this.client.get('/info');
      return response.data.fullHeight || 0;
    } catch (error) {
      throw new Error(`Failed to get current height: ${error}`);
    }
  }

  // Get node info
  async getNodeInfo(): Promise<NodeInfo> {
    try {
      const response = await this.client.get('/info');
      const data = response.data;
      
      return {
        name: data.name || 'ergo-node',
        appVersion: data.appVersion || '0.0.0',
        fullHeight: data.fullHeight || 0,
        headersHeight: data.headersHeight || 0,
        maxPeerHeight: data.maxPeerHeight || 0,
        bestFullHeaderId: data.bestFullHeaderId || '',
        previousFullHeaderId: data.previousFullHeaderId || '',
        stateType: data.stateType || 'utxo',
        difficulty: data.difficulty || 0,
        unconfirmedCount: data.unconfirmedCount || 0,
        headersScore: data.headersScore || 0,
        fullBlocksScore: data.fullBlocksScore || 0,
        launchTime: data.launchTime || 0,
        parameters: {
          height: data.parameters?.height || 0,
          storageFeeFactor: data.parameters?.storageFeeFactor || 1250000,
          minValuePerByte: data.parameters?.minValuePerByte || 360,
          maxBlockSize: data.parameters?.maxBlockSize || 1048576,
          maxBlockCost: data.parameters?.maxBlockCost || 1000000,
          blockVersion: data.parameters?.blockVersion || 1,
          tokenAccessCost: data.parameters?.tokenAccessCost || 100,
          inputCost: data.parameters?.inputCost || 2000,
          dataInputCost: data.parameters?.dataInputCost || 100,
          outputCost: data.parameters?.outputCost || 100
        }
      };
    } catch (error) {
      throw new Error(`Failed to get node info: ${error}`);
    }
  }

  // Register a persistent scan for old boxes (reuse existing scan if available)
  private scanId: string | null = null;
  
  async registerStorageRentScan(cutoffHeight: number): Promise<string> {
    // Reuse existing scan if available
    if (this.scanId) {
      try {
        // Check if scan still exists by trying to get unspent boxes
        await this.client.get(`/scan/unspentBoxes/${this.scanId}`);
        return this.scanId;
      } catch (error) {
        // Scan doesn't exist anymore, create new one
        this.scanId = null;
      }
    }
    
    try {
      // Use simple scan that should definitely return boxes - we'll filter manually
      const scanRequest = {
        scanName: "storage-rent-simple-scan",
        walletInteraction: "off",
        removeOffchain: false,
        trackingRule: {
          predicate: "containsAsset",
          assetId: ""
        }
      };
      
      const response = await this.client.post('/scan/register', scanRequest);
      this.scanId = response.data.scanId;
      return this.scanId!;
    } catch (error) {
      throw new Error(`Failed to register storage rent scan: ${error}`);
    }
  }

  // Get unspent boxes from a scan
  async getUnspentBoxesFromScan(scanId: string, limit: number = 100): Promise<BoxData[]> {
    try {
      const response = await this.client.get(`/scan/unspentBoxes/${scanId}`, {
        params: { minConfirmations: 1, maxItems: limit }
      });
      console.log(`Scan ${scanId} returned ${response.data.length} boxes`);
      if (response.data.length > 0) {
        console.log('First box:', JSON.stringify(response.data[0], null, 2));
      }
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get unspent boxes from scan: ${error}`);
    }
  }

  // Get box details by ID
  async getBoxById(boxId: string): Promise<BoxData | null> {
    try {
      const response = await this.client.get(`/utxo/byId/${boxId}`);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null; // Box not found or spent
      }
      throw new Error(`Failed to get box ${boxId}: ${error.message}`);
    }
  }

  // Calculate box size using Fleet SDK estimation
  private calculateBoxSize(box: BoxData): number {
    try {
      // Use Fleet SDK estimateBoxSize - the official Ergo library
      const fleetSize = estimateBoxSize(box);
      
      console.log(`Box ${box.boxId}: Fleet SDK size=${fleetSize} bytes, rent=${fleetSize * 1250000} nanoErgs`);
      
      return fleetSize;
    } catch (error) {
      console.warn(`Failed to calculate box size for ${box.boxId}:`, error);
      // Fallback to standard box size
      return 49;
    }
  }

  // Estimate VLQ (Variable Length Quantity) encoding size
  private estimateVLQSize(value: number): number {
    if (value < 128) return 1;
    if (value < 16384) return 2;  
    if (value < 2097152) return 3;
    if (value < 268435456) return 4;
    return 5;
  }

  // Scan for boxes and organize by creation height, with infinite search capability
  async scanForEligibleBoxes(
    currentHeight: number,
    minAge: number,
    startOffset: number = 0,
    targetBoxCount: number = 50
  ): Promise<{ boxesByHeight: Map<number, EligibleBox[]>, nextOffset: number }> {
    const boxesByHeight: Map<number, EligibleBox[]> = new Map();
    const cutoffHeight = currentHeight - minAge;
    let totalBoxesFound = 0;
    let nextOffset = startOffset;
    
    try {
      console.log(`Scanning for boxes. Current height: ${currentHeight}, cutoff: ${cutoffHeight}, startOffset: ${startOffset}`);
      
      // INFINITE SEARCH: Continue searching until we find enough boxes
      // Start from a reasonable offset to find boxes around height 495533
      const batchSize = 1000; // Smaller batch for testing
      let boxesChecked = 0;
      let offset = startOffset === 0 ? 44160000 : startOffset; // Start from 10M offset to find recent boxes that will become eligible soon
      
      while (totalBoxesFound < targetBoxCount) {
        try {
          console.log(`Searching box range offset=${offset}, limit=${batchSize}`);
          
          // Get box IDs from this range
          const response = await this.client.get('/blockchain/box/range', {
            params: { offset: offset, limit: batchSize }
          });
          
          response.data = response.data.reverse();

          const boxIds = response.data;
          console.log(`Found ${boxIds.length} box IDs in range`);
          
          // If no more boxes, we've reached the end
          if (boxIds.length === 0) {
            console.log('No more boxes found, ending search');
            break;
          }
          
          // Check each box for eligibility
          for (const boxId of boxIds) {
            try {
              const boxResponse = await this.client.get(`/blockchain/box/byId/${boxId}`);
              const box = boxResponse.data;
              boxesChecked++;
              
              // Progress logging
              if (boxesChecked % 10 === 0) {
                console.log(`Checked ${boxesChecked} boxes. Current: height=${box.creationHeight}, spent=${!!box.spentTransactionId}`);
              }
              
              
              // Skip if box is spent
              if (box.spentTransactionId) {
                continue;
              }
              
              // Calculate when this box becomes eligible
              const eligibleAtHeight = box.creationHeight + minAge;
              const blocksUntilEligible = eligibleAtHeight - currentHeight;
              
              console.log(`Box height: ${box.creationHeight}, eligibleAt: ${eligibleAtHeight}, current: ${currentHeight}, blocksUntil: ${blocksUntilEligible}`);
              
              // Debug unspent boxes
              if (boxesChecked % 100 === 0) {
                console.log(`UNSPENT box ${boxId}: height=${box.creationHeight}, blocksUntil=${blocksUntilEligible}`);
              }
              
              // Skip if too far in future (>1000 blocks)
              if (blocksUntilEligible > 1000) {
                continue;
              }
              
              console.log(`Found eligible/future box: ${boxId}, height: ${box.creationHeight}, eligible in ${blocksUntilEligible} blocks`);
              
              // Calculate box size and rent fee  
              const boxSize = this.calculateBoxSize(box);
              const rentFee = BigInt(boxSize * this.config.rentFeePerByte);
              const boxValue = BigInt(box.value);
              
              console.log(`Box value check: ${boxValue} >= ${rentFee + BigInt(this.config.minBoxValuePerByte * boxSize)}`);
              
              // Check if box has sufficient value to pay rent
              if (boxValue >= rentFee + BigInt(this.config.minBoxValuePerByte * boxSize)) {
                const eligibleBox: EligibleBox = {
                  boxId: box.boxId,
                  creationHeight: box.creationHeight,
                  currentHeight,
                  boxSize,
                  value: boxValue,
                  rentFee,
                  status: blocksUntilEligible <= 0 ? 'pending' : 'queued', // Eligible as soon as blocks reach threshold
                  discoveredAt: new Date(),
                  ergoTree: box.ergoTree,
                  assets: box.assets ? box.assets.map((asset: any) => ({
                    tokenId: asset.tokenId,
                    amount: BigInt(asset.amount)
                  })) : [],
                  additionalRegisters: box.additionalRegisters || {}
                };
                
                // Organize by creation height
                const height = box.creationHeight;
                if (!boxesByHeight.has(height)) {
                  boxesByHeight.set(height, []);
                }
                boxesByHeight.get(height)!.push(eligibleBox);
                totalBoxesFound++;
                
                // Calculate when this box will be claimable
                const claimableAtHeight = box.creationHeight + minAge;
                const blocksUntilClaimable = claimableAtHeight - currentHeight;
                
                console.log(`*** ADDED box to height ${height}: ${boxId}, value: ${boxValue} ***`);
                console.log(`*** Box will be claimable at height ${claimableAtHeight} (in ${blocksUntilClaimable} blocks) ***`);
                
                // Check if we have enough boxes
                if (totalBoxesFound >= targetBoxCount) {
                  console.log(`Found ${totalBoxesFound} boxes organized by height, stopping search`);
                  nextOffset = offset - (batchSize - boxIds.indexOf(boxId));
                  return { boxesByHeight, nextOffset };
                }
              } else {
                console.log(`Box ${boxId} insufficient value: ${boxValue} < ${rentFee + BigInt(this.config.minBoxValuePerByte * boxSize)}`);
              }
              
            } catch (error) {
              console.warn(`Error checking box ${boxId}:`, error);
            }
          }
          
          // Move to next batch
          offset -= batchSize;
          nextOffset = offset;
          
        } catch (error) {
          console.warn(`Error searching range ${offset}-${offset + batchSize}:`, error);
          offset -= batchSize;
          nextOffset = offset;
        }
      }
      
      console.log(`Search complete: found ${totalBoxesFound} boxes organized into ${boxesByHeight.size} height groups from ${boxesChecked} boxes checked`);
      
      // Show next claimable boxes summary
      if (boxesByHeight.size > 0) {
        console.log('\n=== NEXT CLAIMABLE BOXES ===');
        const sortedHeights = Array.from(boxesByHeight.keys()).sort((a, b) => a - b);
        for (const height of sortedHeights) {
          const boxes = boxesByHeight.get(height)!;
          const claimableAtHeight = height + minAge;
          const blocksUntilClaimable = claimableAtHeight - currentHeight;
          console.log(`Height ${height}: ${boxes.length} boxes → claimable at height ${claimableAtHeight} (in ${blocksUntilClaimable} blocks)`);
        }
        console.log('===============================\n');
      }
      
    } catch (error) {
      throw new Error(`Failed to scan for eligible boxes: ${error}`);
    }
    
    return { boxesByHeight, nextOffset };
  }

  // Get wallet UTXOs for a given address
  async getWalletUtxos(address: string): Promise<any[]> {
    try {
      // Use blockchain API to find UTXOs for the address
      const response = await this.client.get('/blockchain/box/unspent/byAddress', {
        params: { address, limit: 100 }
      });
      return response.data;
    } catch (error) {
      console.warn(`Failed to get wallet UTXOs for ${address}:`, error);
      return [];
    }
  }

  // Validate boxes are still unspent
  async validateBoxes(boxIds: string[]): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    // Simplified validation - assume all boxes are valid for now
    // In a real implementation, this would check each box against the node
    return {
      valid: boxIds,
      invalid: []
    };
  }

  // Submit transaction
  async submitTransaction(txBytes: string): Promise<string> {
    if (this.config.dryRun) {
      return 'dry-run-tx-id';
    }

    try {
      const response = await this.client.post('/transactions', txBytes, {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to submit transaction: ${error}`);
    }
  }

  // Check if transaction is confirmed
  async isTransactionConfirmed(txId: string): Promise<boolean> {
    try {
      const response = await this.client.get(`/transactions/${txId}`);
      return response.status === 200 && response.data.numConfirmations > 0;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false; // Transaction not found
      }
      throw new Error(`Failed to check transaction ${txId}: ${error.message}`);
    }
  }

  // Get wallet balance from actual wallet UTXOs
  async getWalletBalance(): Promise<{ balance: bigint }> {
    try {
      // Get wallet address from transaction service
      const walletAddress = this.config.walletMnemonic; // We need the actual address
      
      // This is a simplified implementation - in reality we'd need the wallet address
      // For now, return a reasonable balance since we don't have wallet integration
      return {
        balance: BigInt(1000000000) // 1 ERG minimum
      };
    } catch (error) {
      throw new Error(`Failed to get wallet balance: ${error}`);
    }
  }

} 