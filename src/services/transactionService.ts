import { EligibleBox, Config, StorageRentParameters, BoxData } from '../types';
import { TransactionBuilder, OutputBuilder, ErgoAddress, ErgoUnsignedInput, SShort } from '@fleet-sdk/core';
import { estimateBoxSize } from '@fleet-sdk/serializer';
import * as ergo from 'ergo-lib-wasm-nodejs';
import axios from 'axios';
import jsonBigInt from 'json-bigint';
import { getAddressFromMnemonic, createWallet } from '../utils/ergoUtils';

type StorageRentBuildResult = {
  unsignedTx: any;
  inputBoxes: any[];
  walletInputIndexes: number[];
  walletSubsidy: bigint;
  totalRentCollected: bigint;
  minerFee: bigint;
  collectorValue: bigint;
  collectorTokenCount: number;
};

export class TransactionService {
  private config: Config;
  private walletAddress: string = '';

  constructor(config: Config) {
    this.config = config;
    this.initializeWalletAddress();
  }

  // Initialize wallet address from mnemonic
  private initializeWalletAddress(): void {
    if (!this.config.walletMnemonic || this.config.walletPassword === undefined) {
      this.walletAddress = '';
      return;
    }

    this.walletAddress = getAddressFromMnemonic(
      this.config.walletMnemonic,
      this.config.walletPassword,
      this.config.networkType
    );
  }

  // Get wallet address
  getWalletAddress(): string {
    return this.walletAddress;
  }

  private getStorageRentCollectAddress(): ErgoAddress | null {
    if (this.config.storageRentMode !== 'address') {
      return null;
    }

    if (!this.config.storageRentCollectAddress) {
      throw new Error('STORAGE_RENT_COLLECT_ADDRESS is required when STORAGE_RENT_MODE=address');
    }

    try {
      return ErgoAddress.fromBase58(this.config.storageRentCollectAddress);
    } catch {
      throw new Error('STORAGE_RENT_COLLECT_ADDRESS must be a valid Ergo address');
    }
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

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await mapper(item, index);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  // Build storage rent transaction using Fleet SDK
  async buildStorageRentTransaction(
    boxes: EligibleBox[],
    changeAddress: string,
    currentHeight: number,
    ergoNode: any,
    rentParams: StorageRentParameters
  ): Promise<StorageRentBuildResult> {
    const spendHeight = currentHeight + 1;
    const fleetInputs: ErgoUnsignedInput[] = [];
    const inputBoxes: any[] = [];
    const walletInputIndexes: number[] = [];
    const outputs: OutputBuilder[] = [];
    const burnedTokenAmounts = new Map<string, bigint>();
    const collectedTokenAmounts = new Map<string, bigint>();
    const collectAddress = this.getStorageRentCollectAddress();
    let collectedInputValue = 0n;
    let walletSubsidy = 0n;
    let walletInputValue = 0n;
    const plans: Array<{
      input: ErgoUnsignedInput;
      boxId: string;
      mode: 'recreate' | 'consume' | 'collect';
      outputIndex?: number;
      feeContribution: bigint;
      inputValue: bigint;
      outputValue: bigint;
      storageFee: bigint;
    }> = [];
    const addBurnedToken = (tokenId: string, amount: bigint): void => {
      burnedTokenAmounts.set(tokenId, (burnedTokenAmounts.get(tokenId) || 0n) + amount);
    };
    const addCollectedToken = (tokenId: string, amount: bigint): void => {
      collectedTokenAmounts.set(tokenId, (collectedTokenAmounts.get(tokenId) || 0n) + amount);
    };
    const nodeBoxes = await this.mapWithConcurrency(
      boxes,
      Math.max(1, Math.min(this.config.scanBoxDetailConcurrency, boxes.length)),
      async box => {
        if (box.boxData) {
          return box.boxData;
        }

        const nodeBoxData = await ergoNode.getBoxById(box.boxId);
        if (!nodeBoxData) {
          throw new Error(`Box ${box.boxId} not found or already spent`);
        }

        return nodeBoxData;
      }
    );

    for (const [index, box] of boxes.entries()) {
      try {
        const nodeBoxData = nodeBoxes[index];
        if (!nodeBoxData) {
          throw new Error(`Box ${box.boxId} not found or already spent`);
        }

        const inputValue = BigInt(nodeBoxData.value);
        const boxSize = estimateBoxSize(nodeBoxData);
        const storageFee = BigInt(boxSize) * BigInt(rentParams.storageFeeFactor);
        const fleetInput = new ErgoUnsignedInput(nodeBoxData);
        const inputAssets = nodeBoxData.assets || [];
        const canCollectAssets = collectAddress && inputAssets.length > 0;

        if (canCollectAssets) {
          fleetInputs.push(fleetInput);
          inputBoxes.push(nodeBoxData);
          for (const asset of inputAssets) {
            addCollectedToken(asset.tokenId, BigInt(asset.amount));
          }

          collectedInputValue += inputValue;
          plans.push({
            input: fleetInput,
            boxId: box.boxId,
            mode: 'collect',
            feeContribution: 0n,
            inputValue,
            outputValue: 0n,
            storageFee
          });
          continue;
        }

        if (inputValue <= storageFee) {
          throw new Error(
            `Box ${box.boxId} has only ${inputValue} nanoErgs for ${storageFee} nanoErgs of storage rent; underfunded boxes need an external subsidy input`
          );
        }

        const targetAddress = ErgoAddress.fromErgoTree(nodeBoxData.ergoTree);
        let outputValue = inputValue - storageFee;
        const output = new OutputBuilder(outputValue.toString(), targetAddress)
          .addTokens(inputAssets.map((asset: any) => ({
            tokenId: asset.tokenId,
            amount: BigInt(asset.amount)
          })))
          .setAdditionalRegisters(nodeBoxData.additionalRegisters || {})
          .setCreationHeight(spendHeight);

        const minOutputValue = BigInt(output.estimateSize()) * BigInt(rentParams.minValuePerByte);
        if (outputValue < minOutputValue) {
          outputValue = minOutputValue;
          output.setValue(outputValue.toString());
        }

        const feeContribution = inputValue - outputValue;
        if (feeContribution <= 0n) {
          throw new Error(`Box ${box.boxId} cannot pay positive storage rent after min-box-value reserve`);
        }

        const outputIndex = outputs.length;
        fleetInputs.push(fleetInput);
        inputBoxes.push(nodeBoxData);
        outputs.push(output);
        plans.push({
          input: fleetInput,
          boxId: box.boxId,
          mode: 'recreate',
          outputIndex,
          feeContribution,
          inputValue,
          outputValue,
          storageFee
        });
      } catch (error) {
        throw new Error(`Failed to plan storage rent input ${box.boxId}: ${error}`);
      }
    }

    let collectorValue = 0n;
    let collectorOutputIndex: number | undefined;

    if (collectAddress && collectedInputValue > 0n && collectedTokenAmounts.size > 0) {
      const collectedTokens = Array.from(collectedTokenAmounts.entries()).map(([tokenId, amount]) => ({
        tokenId,
        amount
      }));
      const collectorOutput = new OutputBuilder('1', collectAddress)
        .addTokens(collectedTokens)
        .setCreationHeight(spendHeight);
      const minCollectorValue = BigInt(collectorOutput.estimateSize()) * BigInt(rentParams.minValuePerByte);

      if (collectedInputValue > minCollectorValue) {
        collectorValue = minCollectorValue;
      } else if (this.config.enableAssetSubsidy) {
        walletSubsidy = minCollectorValue;
        const maxSubsidy = BigInt(this.config.maxAssetSubsidyNanoErgs);
        if (walletSubsidy > maxSubsidy) {
          throw new Error(
            `Asset subsidy ${walletSubsidy} nanoErgs exceeds MAX_ASSET_SUBSIDY_NANOERGS=${maxSubsidy}`
          );
        }

        collectorValue = minCollectorValue;
        walletInputValue = await this.addWalletSubsidyInputs(
          ergoNode,
          changeAddress,
          walletSubsidy,
          fleetInputs,
          inputBoxes,
          walletInputIndexes
        );
      } else {
        throw new Error(
          `Asset collection needs ${minCollectorValue} nanoErgs for the collector output; enable ENABLE_ASSET_SUBSIDY or skip this box`
        );
      }

      collectorOutput.setValue(collectorValue.toString());
      collectorOutputIndex = outputs.length;
      outputs.push(collectorOutput);
    }

    const feeOutputIndex = outputs.length;
    for (const plan of plans) {
      const targetOutputIndex = plan.mode === 'recreate'
        ? plan.outputIndex!
        : plan.mode === 'collect' && collectorOutputIndex !== undefined
          ? collectorOutputIndex
          : feeOutputIndex;
      plan.input.setContextExtension({ 127: SShort(targetOutputIndex) });
    }

    const totalStorageRentInputValue = plans.reduce((sum, plan) => sum + plan.inputValue, 0n);
    const totalInputValue = totalStorageRentInputValue + walletInputValue;
    const totalRecreatedValue = plans.reduce((sum, plan) => sum + plan.outputValue, 0n);
    const planFeeContribution = plans.reduce((sum, plan) => sum + plan.feeContribution, 0n);
    const collectFeeContribution = collectorOutputIndex === undefined
      ? 0n
      : walletSubsidy > 0n
        ? collectedInputValue
        : collectedInputValue - collectorValue;
    const minerFee = planFeeContribution + collectFeeContribution;
    const totalRentCollected = planFeeContribution + (collectorOutputIndex === undefined ? 0n : collectedInputValue);
    const burnedTokens = Array.from(burnedTokenAmounts.entries()).map(([tokenId, amount]) => ({
      tokenId,
      amount
    }));
    const collectorTokenCount = collectedTokenAmounts.size;

    if (minerFee <= 0n) {
      throw new Error('No positive miner fee can be collected from this batch');
    }

    console.log('\n=== STORAGE RENT TRANSACTION PLAN ===');
    console.log(`Mode: ${this.config.storageRentMode}`);
    console.log(`Spend height: ${spendHeight}`);
    console.log(`Total input value: ${totalInputValue} nanoErgs`);
    console.log(`Storage-rent input value: ${totalStorageRentInputValue} nanoErgs`);
    console.log(`Wallet subsidy: ${walletSubsidy} nanoErgs`);
    console.log(`Recreated value: ${totalRecreatedValue} nanoErgs`);
    console.log(`Collector value: ${collectorValue} nanoErgs`);
    console.log(`Collector token entries: ${collectorTokenCount}`);
    console.log(`Miner fee value: ${minerFee} nanoErgs`);
    console.log(`Burned token entries: ${burnedTokens.length}`);
    for (const plan of plans) {
      console.log(`  ${plan.boxId}: ${plan.mode}, input=${plan.inputValue}, output=${plan.outputValue}, fee=${plan.feeContribution}, storageFee=${plan.storageFee}`);
    }
    console.log('=====================================\n');

    let txBuilder = new TransactionBuilder(spendHeight)
      .from(fleetInputs)
      .payFee(minerFee.toString());

    if (outputs.length > 0) {
      txBuilder = txBuilder.to(outputs);
    }

    if (burnedTokens.length > 0) {
      txBuilder = txBuilder
        .burnTokens(burnedTokens)
        .configure(settings => settings.allowTokenBurning());
    }

    if (walletInputIndexes.length > 0) {
      txBuilder = txBuilder.sendChangeTo(changeAddress);
    }

    const unsignedTx = txBuilder
      .build()
      .toEIP12Object();

    return {
      unsignedTx,
      inputBoxes,
      walletInputIndexes,
      walletSubsidy,
      totalRentCollected,
      minerFee,
      collectorValue,
      collectorTokenCount
    };
  }

  private async addWalletSubsidyInputs(
    ergoNode: any,
    changeAddress: string,
    requiredValue: bigint,
    fleetInputs: ErgoUnsignedInput[],
    inputBoxes: any[],
    walletInputIndexes: number[]
  ): Promise<bigint> {
    if (requiredValue <= 0n) {
      return 0n;
    }

    if (!changeAddress || !this.config.walletMnemonic || this.config.walletPassword === undefined) {
      throw new Error('Wallet mnemonic is required for asset subsidy inputs');
    }

    const excludedBoxIds = new Set(inputBoxes.map(box => box.boxId));
    const walletUtxos = await ergoNode.getWalletUtxos(changeAddress);
    const { boxes, totalValue } = this.selectWalletSubsidyBoxes(walletUtxos, requiredValue, excludedBoxIds);

    for (const walletBox of boxes) {
      walletInputIndexes.push(fleetInputs.length);
      fleetInputs.push(new ErgoUnsignedInput(walletBox));
      inputBoxes.push(walletBox);
    }

    return totalValue;
  }

  private selectWalletSubsidyBoxes(
    utxos: BoxData[],
    requiredValue: bigint,
    excludedBoxIds: Set<string>
  ): { boxes: BoxData[]; totalValue: bigint } {
    const candidates = utxos
      .filter(box => !excludedBoxIds.has(box.boxId))
      .filter(box => (box.assets || []).length === 0)
      .sort((a, b) => {
        const aValue = BigInt(a.value);
        const bValue = BigInt(b.value);
        if (aValue === bValue) {
          return 0;
        }
        return aValue < bValue ? -1 : 1;
      });

    const selected: BoxData[] = [];
    let totalValue = 0n;

    for (const box of candidates) {
      selected.push(box);
      totalValue += BigInt(box.value);
      if (totalValue >= requiredValue) {
        return { boxes: selected, totalValue };
      }
    }

    throw new Error(`Wallet has no pure ERG UTXO set covering ${requiredValue} nanoErgs for asset subsidy`);
  }

  // Sign and submit transaction using ergo-lib-wasm (fromUnsigned function)
  async fromUnsigned(unsignedTxJson: any): Promise<[string | null, any]> {
    try {
      const { signedTx } = this.createStorageRentSignedTx(unsignedTxJson);
      const txId = await this.sendTx(signedTx);

      return [txId, signedTx];
    } catch (e) {
      console.error(e);
      return [null, null];
    }
  }

  async createSignedStorageRentTransaction(
    unsignedTxJson: any,
    inputBoxes: any[] = [],
    walletInputIndexes: number[] = []
  ): Promise<{ txId: string; signedTx: string }> {
    if (walletInputIndexes.length === 0) {
      return this.createStorageRentSignedTx(unsignedTxJson);
    }

    return this.createMixedStorageRentSignedTx(unsignedTxJson, inputBoxes, walletInputIndexes);
  }

  // Create signed transaction for storage rent (no actual signing needed)
  private createStorageRentSignedTx(unsignedTxJson: any): { txId: string; signedTx: string } {
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

    console.log(`Signed storage-rent transaction ${txId}: inputs=${signedInputs.length}, outputs=${signedTxJson.outputs.length}`);

    return {
      txId,
      signedTx: jsonBigInt.stringify(signedTxJson)
    };
  }

  private async createMixedStorageRentSignedTx(
    unsignedTxJson: any,
    inputBoxes: any[],
    walletInputIndexes: number[]
  ): Promise<{ txId: string; signedTx: string }> {
    if (inputBoxes.length !== unsignedTxJson.inputs.length) {
      throw new Error(`Cannot sign subsidized transaction: ${inputBoxes.length} input boxes for ${unsignedTxJson.inputs.length} unsigned inputs`);
    }

    const unsignedTx = ergo.UnsignedTransaction.from_json(jsonBigInt.stringify(unsignedTxJson));
    const txId = unsignedTx.id().to_str();
    const ctx = await this.getErgoStateContext();
    const wallet = this.createWallet();
    const boxesToSpend = ergo.ErgoBoxes.from_boxes_json(inputBoxes);
    const dataBoxes = ergo.ErgoBoxes.from_boxes_json([]);
    const walletIndexSet = new Set(walletInputIndexes);
    const proofs = unsignedTxJson.inputs.map(() => new Uint8Array());

    for (const inputIndex of walletIndexSet) {
      if (inputIndex < 0 || inputIndex >= unsignedTxJson.inputs.length) {
        throw new Error(`Wallet input index ${inputIndex} is outside unsigned transaction inputs`);
      }

      const signedInput = wallet.sign_tx_input(inputIndex, ctx, unsignedTx, boxesToSpend, dataBoxes);
      proofs[inputIndex] = signedInput.spending_proof().proof();
    }

    const signedTx = ergo.Transaction.from_unsigned_tx(unsignedTx, proofs).to_js_eip12();

    console.log(
      `Signed subsidized storage-rent transaction ${txId}: inputs=${unsignedTxJson.inputs.length}, ` +
      `walletInputs=${walletIndexSet.size}, outputs=${unsignedTxJson.outputs.length}`
    );

    return {
      txId,
      signedTx: jsonBigInt.stringify(signedTx)
    };
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
    if (!this.config.walletMnemonic || this.config.walletPassword === undefined) {
      throw new Error('Wallet mnemonic is not configured');
    }

    return createWallet(this.config.walletMnemonic, this.config.walletPassword);
  }

  // Send transaction to network
  private async sendTx(signedTx: any): Promise<string> {
    const url = this.config.txSubmitNodeUrl + '/transactions';

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
