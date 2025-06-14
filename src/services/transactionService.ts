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
    currentHeight: number,
    ergoNode?: any
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

    // Calculate total input value
    const totalInputValue = boxes.reduce((sum, box) => sum + box.value, 0n);
    
    // Calculate total output value (new boxes + rent collection)
    const totalOutputValue = boxes.reduce((sum, box) => sum + (box.value - box.rentFee), 0n) + totalRentCollected;
    
    // Calculate transaction fee
    const transactionFee = BigInt(RECOMMENDED_MIN_FEE_VALUE);
    
    // LOG DETAILED BREAKDOWN
    console.log('\n=== TRANSACTION CALCULATION ===');
    console.log(`Total input value: ${totalInputValue} nanoErgs`);
    console.log(`Total output value: ${totalOutputValue} nanoErgs`);
    console.log(`  - New boxes total: ${boxes.reduce((sum, box) => sum + (box.value - box.rentFee), 0n)} nanoErgs`);
    console.log(`  - Rent collected: ${totalRentCollected} nanoErgs`);
    console.log(`Transaction fee: ${transactionFee} nanoErgs`);
    console.log(`Input - Output: ${totalInputValue - totalOutputValue} nanoErgs (should cover fee)`);
    console.log(`Box count: ${boxes.length}`);
    boxes.forEach((box, i) => {
      console.log(`  Box ${i}: input=${box.value}, output=${box.value - box.rentFee}, rent=${box.rentFee}`);
    });
    console.log('===============================\n');
    
    // The math should be: inputs = outputs + fee
    // So: totalInputValue = totalOutputValue + transactionFee
    // Which means: totalInputValue - totalOutputValue should >= transactionFee
    const availableForFee = totalInputValue - totalOutputValue;
    console.log(`Available for fee: ${availableForFee} nanoErgs, needed: ${transactionFee} nanoErgs`);
    
    let allInputBoxes = inputBoxes;
    
    if (availableForFee < transactionFee) {
      // Need additional wallet UTXOs to cover the shortfall
      const shortfall = transactionFee - availableForFee;
      
      if (!ergoNode) {
        throw new Error(`Insufficient fee available from claimed boxes. Available: ${availableForFee}, Need: ${transactionFee} (shortfall: ${shortfall}). No ergoNode provided to get wallet UTXOs.`);
      }
      
      console.log(`Need additional ${shortfall} nanoErgs from wallet UTXOs`);
      
      // Get wallet UTXOs
      const walletUtxos = await ergoNode.getWalletUtxos(changeAddress);
      
      if (walletUtxos.length === 0) {
        throw new Error(`Insufficient fee available from claimed boxes and no wallet UTXOs available. Fee available: ${availableForFee}, Fee needed: ${transactionFee} (shortfall: ${shortfall})`);
      }
      
      // Add wallet UTXOs until we have enough
      let walletValue = 0n;
      const additionalInputs = [];
      
      for (const utxo of walletUtxos) {
        additionalInputs.push({
          boxId: utxo.boxId,
          transactionId: utxo.transactionId,
          index: utxo.index,
          value: utxo.value.toString(),
          ergoTree: utxo.ergoTree,
          assets: utxo.assets || [],
          additionalRegisters: utxo.additionalRegisters || {},
          creationHeight: utxo.creationHeight
        });
        
        walletValue += BigInt(utxo.value);
        
        if (walletValue >= shortfall) {
          break;
        }
      }
      
      if (walletValue < shortfall) {
        throw new Error(`Insufficient wallet UTXOs. Have: ${walletValue}, Need: ${shortfall}`);
      }
      
      allInputBoxes = [...inputBoxes, ...additionalInputs];
      console.log(`Added ${additionalInputs.length} wallet UTXOs providing ${walletValue} nanoErgs`);
    }
    
    // The fee will be automatically deducted from inputs by Fleet SDK
    // So we collect the full rent amount and let the SDK handle fee payment
    const rentCollectionOutput = new OutputBuilder(
      totalRentCollected.toString(),
      changeAddr
    );

    const unsignedTx = new TransactionBuilder(currentHeight)
      .from(allInputBoxes)
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