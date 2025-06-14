import axios, { AxiosInstance } from 'axios';
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
      timeout: 30000,
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

  // Register a scan for old boxes
  async registerStorageRentScan(minHeight: number): Promise<string> {
    try {
      const scanRequest = {
        scanName: `storage-rent-scan-${Date.now()}`,
        walletInteraction: "off",
        removeOffchain: true,
        trackingRule: {
          predicate: "containsAsset",
          assetId: ""
        }
      };

      const response = await this.client.post('/scan/register', scanRequest);
      return response.data.scanId;
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

  // Calculate box size from box data
  private calculateBoxSize(box: BoxData): number {
    // Base size: value (8) + ergoTree + creationHeight (4) + tokens + registers
    let size = 8 + 4; // value + creation height
    
    // ErgoTree size (hex string / 2)
    size += box.ergoTree.length / 2;
    
    // Assets size (32 bytes tokenId + 8 bytes amount per asset)
    size += box.assets.length * 40;
    
    // Additional registers size (estimate)
    for (const [key, value] of Object.entries(box.additionalRegisters || {})) {
      size += 1 + (value.length / 2); // register key + value
    }
    
    // Add some overhead
    size += 20;
    
    return size;
  }

  // Scan for eligible boxes using the node's scan API
  async scanForEligibleBoxes(
    currentHeight: number,
    minAge: number,
    batchSize: number = 100,
    maxBatches: number = 20
  ): Promise<EligibleBox[]> {
    const eligibleBoxes: EligibleBox[] = [];
    const cutoffHeight = currentHeight - minAge;
    
    try {
      // Register a scan for old boxes
      const scanId = await this.registerStorageRentScan(cutoffHeight);
      
      // Wait a moment for the scan to process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get unspent boxes from the scan
      const boxes = await this.getUnspentBoxesFromScan(scanId, batchSize);
      
      for (const box of boxes) {
        try {
          // Filter by height - only process boxes older than cutoff
          if (box.creationHeight > cutoffHeight) {
            continue;
          }
          
          // Calculate box size and rent fee
          const boxSize = this.calculateBoxSize(box);
          const rentFee = BigInt(boxSize * this.config.rentFeePerByte);
          const boxValue = BigInt(box.value);
          
          // Check if box has sufficient value to pay rent
          if (boxValue >= rentFee + BigInt(this.config.minBoxValuePerByte * boxSize)) {
            const eligibleBox: EligibleBox = {
              boxId: box.boxId,
              creationHeight: box.creationHeight,
              currentHeight,
              boxSize,
              value: boxValue,
              rentFee,
              status: 'pending',
              discoveredAt: new Date(),
              ergoTree: box.ergoTree,
              assets: box.assets.map(asset => ({
                tokenId: asset.tokenId,
                amount: BigInt(asset.amount)
              })),
              additionalRegisters: box.additionalRegisters || {}
            };
            
            eligibleBoxes.push(eligibleBox);
          }
        } catch (error) {
          console.warn(`Error processing box ${box.boxId}:`, error);
        }
      }
      
      // Clean up the scan
      try {
        await this.client.post(`/scan/deregister`, { scanId });
      } catch (error) {
        console.warn(`Failed to deregister scan ${scanId}:`, error);
      }
      
    } catch (error) {
      throw new Error(`Failed to scan for eligible boxes: ${error}`);
    }
    
    return eligibleBoxes;
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
      // In dry run mode, just return a mock transaction ID
      return this.generateMockTxId();
    }

    try {
      // In a real implementation, this would submit the transaction to the node
      // For now, just return a mock transaction ID
      return this.generateMockTxId();
    } catch (error) {
      throw new Error(`Failed to submit transaction: ${error}`);
    }
  }

  // Check if transaction is confirmed
  async isTransactionConfirmed(txId: string): Promise<boolean> {
    try {
      // In a real implementation, this would check the transaction status
      // For now, just return true after a delay to simulate confirmation
      return Math.random() > 0.5; // 50% chance of being confirmed
    } catch (error) {
      return false;
    }
  }

  // Get wallet balance (simplified)
  async getWalletBalance(): Promise<{ balance: bigint }> {
    // Mock wallet balance
    return {
      balance: BigInt(Math.floor(Math.random() * 100000000000) + 10000000000) // 10-100 ERG
    };
  }

  // Generate mock box ID
  private generateMockBoxId(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 64; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Generate mock transaction ID
  private generateMockTxId(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 64; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
} 