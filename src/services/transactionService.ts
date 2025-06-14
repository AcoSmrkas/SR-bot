import { EligibleBox, Config, TransactionResult } from '../types';
import { TransactionBuilder, OutputBuilder, ErgoAddress, RECOMMENDED_MIN_FEE_VALUE } from '@fleet-sdk/core';
import * as ergo from 'ergo-lib-wasm-nodejs';
import axios from 'axios';
import jsonBigInt from 'json-bigint';
import { getAddressFromMnemonic, createWallet } from '../utils/ergoUtils';

export class TransactionService {
  private config: Config;
  private walletAddress: string = '';

  constructor(config: Config) {
    this.config = config;
    this.initializeWalletAddress();
  }

  // Initialize wallet address from mnemonic
  private initializeWalletAddress(): void {
    this.walletAddress = getAddressFromMnemonic(this.config.walletMnemonic, this.config.walletPassword);
  }

  // Get wallet address
  getWalletAddress(): string {
    return this.walletAddress;
  }

  // Create transaction batches
  createTransactionBatches(boxes: EligibleBox[]): EligibleBox[][] {
    const batches: EligibleBox[][] = [];
    const batchSize = this.config.maxBoxesPerTx;
    
    for (let i = 0; i < boxes.length; i += batchSize) {
      batches.push(boxes.slice(i, i + batchSize));
    }
    
    return batches;
  }

  // Build storage rent transaction using Fleet SDK
  async buildStorageRentTransaction(
    boxes: EligibleBox[],
    changeAddress: string,
    currentHeight: number
  ): Promise<{
    unsignedTx: any;
    inputBoxes: any[];
    totalRentCollected: bigint;
  }> {
    let totalRentCollected = 0n;
    
    // Calculate total rent to collect
    for (const box of boxes) {
      totalRentCollected += box.rentFee;
    }

    // Convert eligible boxes to Fleet SDK format
    const inputBoxes = boxes.map((box, index) => ({
      boxId: box.boxId,
      transactionId: box.boxId.substring(0, 64), // Extract transaction ID
      index: 0, // Assume index 0 for now
      value: box.value.toString(),
      ergoTree: box.ergoTree,
      assets: box.assets.map(asset => ({
        tokenId: asset.tokenId,
        amount: asset.amount.toString()
      })),
      additionalRegisters: box.additionalRegisters,
      creationHeight: box.creationHeight
    }));

    // Build transaction using Fleet SDK
    const changeAddr = ErgoAddress.fromBase58(changeAddress);
    
    // Create outputs for each box (preserving content but collecting rent)
    const outputs = boxes.map(box => {
      const newValue = box.value - box.rentFee; // Deduct rent fee
      const targetAddress = ErgoAddress.fromErgoTree(box.ergoTree);
      
      return new OutputBuilder(
        newValue.toString(),
        targetAddress
      )
      .addTokens(box.assets.map(asset => ({
        tokenId: asset.tokenId,
        amount: asset.amount.toString()
      })))
      .setAdditionalRegisters(box.additionalRegisters);
    });

    // Deduct transaction fee from collected rent
    const transactionFee = BigInt(RECOMMENDED_MIN_FEE_VALUE);
    const rentAfterFee = totalRentCollected - transactionFee;
    
    if (rentAfterFee <= 0n) {
      throw new Error(`Insufficient rent collected to pay transaction fee. Collected: ${totalRentCollected}, Fee: ${transactionFee}`);
    }

    // Add change output to collect rent fees (minus transaction fee)
    const rentCollectionOutput = new OutputBuilder(
      rentAfterFee.toString(),
      changeAddr
    );

    const unsignedTx = new TransactionBuilder(currentHeight)
      .from(inputBoxes)
      .to([...outputs, rentCollectionOutput])
      .sendChangeTo(changeAddr)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build()
      .toEIP12Object();

    return {
      unsignedTx,
      inputBoxes,
      totalRentCollected
    };
  }

  // Sign and submit transaction using ergo-lib-wasm (fromUnsigned function)
  async fromUnsigned(unsignedTxJson: any): Promise<[string | null, any]> {
    try {
      const unsignedTx = ergo.UnsignedTransaction.from_json(jsonBigInt.stringify(unsignedTxJson));
      
      const inputBoxes = ergo.ErgoBoxes.from_boxes_json(unsignedTxJson.inputs);
      
      const signedTx = await this.signTx(unsignedTx, inputBoxes);
      const txId = await this.sendTx(signedTx);
      
      return [txId, jsonBigInt.parse(signedTx.to_json())];
    } catch (e) {
      console.error(e);
      return [null, null];
    }
  }

  // Sign transaction with wallet mnemonic
  private async signTx(unsignedTx: any, inputs: any): Promise<any> {
    const ctx = await this.getErgoStateContext();
    const wallet = this.createWallet();
    const inputDataBoxes = ergo.ErgoBoxes.from_boxes_json([]);
    
    const signedTx = wallet.sign_transaction(ctx, unsignedTx, inputs, inputDataBoxes);
    return signedTx;
  }

  // Create wallet from mnemonic
  private createWallet(): any {
    return createWallet(this.config.walletMnemonic, this.config.walletPassword);
  }

  // Send transaction to network
  private async sendTx(signedTx: any): Promise<string> {
    const url = this.config.ergoNodeUrl + '/transactions';
    const data = signedTx.to_json();
    
    const headers: any = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    // Add API key if available
    if (this.config.ergoNodeApiKey) {
      headers['api_key'] = this.config.ergoNodeApiKey;
    }

    const response = await axios.post(url, data, { headers });
    return response.data;
  }

  // Get Ergo state context for signing
  private async getErgoStateContext(): Promise<any> {
    let explorerHeaders = [];
    try {
      const response = await this.getExplorerBlockHeaders();
      explorerHeaders = response.items.slice(0, 10);
    } catch (e) {
      console.log('Error getting block headers:', e);
    }

    const block_headers = ergo.BlockHeaders.from_json(explorerHeaders);
    const pre_header = ergo.PreHeader.from_block_header(block_headers.get(0));
    return new ergo.ErgoStateContext(pre_header, block_headers);
  }

  // Get block headers from explorer
  private async getExplorerBlockHeaders(): Promise<any> {
    const explorerUrl = this.config.networkType === 'testnet' 
      ? 'https://api-testnet.ergoplatform.com' 
      : 'https://api.ergoplatform.com';
    
    const response = await axios.get(`${explorerUrl}/api/v1/blocks/headers`);
    return response.data;
  }

  // Validate transaction
  async validateTransaction(boxes: EligibleBox[], unsignedTx: any): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    // Basic validation
    if (!unsignedTx) {
      return { valid: false, errors: ['Empty unsigned transaction'] };
    }

    if (boxes.length === 0) {
      return { valid: false, errors: ['No boxes to process'] };
    }

    return { valid: true, errors: [] };
  }

  // Calculate box size (simplified)
  calculateBoxSize(box: any): number {
    // Simplified calculation - in reality this would be more complex
    return 105; // Standard box size
  }

  // Calculate rent fee
  calculateRentFee(boxSize: number): bigint {
    return BigInt(boxSize * this.config.rentFeePerByte);
  }

  // Cleanup resources
  cleanup(): void {
    // Cleanup any resources if needed
  }
} 