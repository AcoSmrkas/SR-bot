import { EligibleBox, Config } from '../types';
import { TransactionBuilder, OutputBuilder, ErgoAddress, RECOMMENDED_MIN_FEE_VALUE, ErgoUnsignedInput } from '@fleet-sdk/core';
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

    // Create Fleet SDK inputs with context extensions for storage rent
    const fleetInputs = [];
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!; // Non-null assertion since we're iterating through boxes array
      console.log(`Creating Fleet SDK input for box: ${box.boxId}`);
      
      try {
        const nodeBoxData = await ergoNode.getBoxById(box.boxId);
        if (!nodeBoxData) {
          throw new Error(`Box ${box.boxId} not found or already spent`);
        }
        
        // Create Fleet SDK input
        const fleetInput = new ErgoUnsignedInput(nodeBoxData);
        
        // Set context extension: variable 0x7f (127 decimal) = output index (hex encoded)
        // Use their pattern: even indices only (input_index * 2)
        const outputIndex = (i * 2).toString(16).padStart(2, '0'); // Convert to 2-digit hex
        fleetInput.setContextExtension({ 0x7f: `03${outputIndex}` }); // Storage rent key 0x7f + 03 prefix + hex index
        
        console.log(`Set context extension for input ${i}: { 0x7f: "03${outputIndex}" }`);
        fleetInputs.push(fleetInput);
      } catch (error) {
        throw new Error(`Failed to create Fleet SDK input for ${box.boxId}: ${error}`);
      }
    }
    
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
      .setAdditionalRegisters(box.additionalRegisters)
      .setCreationHeight(currentHeight + 1); // Set to current height + 1 for recreated boxes
    });

    // Calculate total input value
    const totalInputValue = boxes.reduce((sum, box) => sum + box.value, 0n);
    
    // Calculate total output value (new boxes + rent collection minus fee)
    const rentAfterFee = totalRentCollected - BigInt(RECOMMENDED_MIN_FEE_VALUE);
    const totalOutputValue = boxes.reduce((sum, box) => sum + (box.value - box.rentFee), 0n) + rentAfterFee;
    
    // Calculate transaction fee
    const transactionFee = BigInt(RECOMMENDED_MIN_FEE_VALUE);
    
    // LOG DETAILED BREAKDOWN
    console.log('\n=== TRANSACTION CALCULATION ===');
    console.log(`Total input value: ${totalInputValue} nanoErgs`);
    console.log(`Total output value: ${totalOutputValue} nanoErgs`);
    console.log(`  - New boxes total: ${boxes.reduce((sum, box) => sum + (box.value - box.rentFee), 0n)} nanoErgs`);
    console.log(`  - Rent collected (after fee): ${rentAfterFee} nanoErgs (${totalRentCollected} - ${transactionFee})`);
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
    
    // For now, only use the storage rent boxes - wallet UTXO support can be added later
    if (availableForFee < transactionFee) {
      throw new Error(`Insufficient fee available from claimed boxes. Available: ${availableForFee}, Need: ${transactionFee}. Wallet UTXO support not implemented yet.`);
    }
    
    // Send all collected rent directly to miners via fee (no rent collection for ourselves)
    console.log(`Sending all collected rent (${totalRentCollected} nanoErgs) to miners via transaction fee`);

    // Build storage rent transaction - all rent goes to miners, no rent collection output
    const unsignedTx = new TransactionBuilder(currentHeight)
      .from(fleetInputs) // Use Fleet SDK inputs with context extensions
      .to(outputs) // Only recreated boxes, no rent collection
      .payFee(totalRentCollected.toString()) // Pay ALL collected rent as fee to miners
      .build()
      .toEIP12Object();

    return {
      unsignedTx,
      inputBoxes: fleetInputs, // Return Fleet SDK inputs
      totalRentCollected
    };
  }

  // Sign and submit transaction using ergo-lib-wasm (fromUnsigned function)
  async fromUnsigned(unsignedTxJson: any): Promise<[string | null, any]> {
    try {
      console.log('=== UNSIGNED TRANSACTION DETAILS ===');
      console.log(JSON.stringify(unsignedTxJson, null, 4));
      console.log('=====================================');

      // For storage rent transactions, create signed transaction manually with empty proofs
      const signedTx = this.createStorageRentSignedTx(unsignedTxJson);
      const txId = await this.sendTx(signedTx);
      
      return [txId, signedTx];
    } catch (e) {
      console.error(e);
      return [null, null];
    }
  }

  // Create signed transaction for storage rent (no actual signing needed)
  private createStorageRentSignedTx(unsignedTxJson: any): any {
    console.log(unsignedTxJson);

    const txId = ergo.UnsignedTransaction.from_json(jsonBigInt.stringify(unsignedTxJson)).id().to_str();
    // For storage rent claims, inputs have empty proofBytes but keep context extensions
    const signedInputs = unsignedTxJson.inputs.map((input: any) => ({
      boxId: input.boxId,
      spendingProof: {
        proofBytes: "", // Empty proof for storage rent
        extension: input.extension || {} // Keep context extension
      }
    }));
    
    const signedTxJson = {
      id: txId,
      inputs: signedInputs,
      dataInputs: unsignedTxJson.dataInputs || [],
      outputs: unsignedTxJson.outputs // Keep outputs exactly as-is
    };

    console.log('=== STORAGE RENT SIGNED TRANSACTION ===');
    console.log(JSON.stringify(signedTxJson, null, 4));
    console.log('=======================================');

    return jsonBigInt.stringify(signedTxJson);
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
    
    const headers: any = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    // Add API key if available
    if (this.config.ergoNodeApiKey) {
      headers['api_key'] = this.config.ergoNodeApiKey;
    }

    const response = await axios.post(url, signedTx, { headers });
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