import axios, { AxiosInstance } from 'axios';
import { estimateBoxSize } from '@fleet-sdk/serializer';
import {
  Config,
  NodeInfo,
  BoxData,
  EligibleBox,
  StorageRentParameters,
  SubmitNode,
  SubmitNodeCandidate,
  NodeSubmitResult,
  BroadcastResult
} from '../types';
import { Database } from '../database';

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export class ErgoNodeService {
  private client: AxiosInstance;
  private config: Config;
  private headers: Record<string, string>;
  private database: Database | undefined;
  private activeSubmitNodesCache: { nodes: SubmitNode[]; updatedAt: number } | null = null;
  private activeIndexedNodeUrlsCache: { urls: string[]; updatedAt: number } | null = null;
  private discoveredSubmitNodeUrlsCache: { urls: string[]; updatedAt: number } | null = null;
  private inactiveSubmitNodeUrls: Map<string, number> = new Map();

  constructor(config: Config, database?: Database) {
    this.config = config;
    this.database = database;

    this.headers = {
      'Content-Type': 'application/json',
    };

    // Add API key if provided
    if (config.ergoNodeApiKey) {
      this.headers['api_key'] = config.ergoNodeApiKey;
    }

    this.client = axios.create({
      baseURL: config.ergoNodeUrl,
      timeout: 10000,
      headers: this.headers,
    });
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      await this.getNodeInfo();
      return true;
    } catch (error) {
      return false;
    }
  }

  // Get current blockchain height
  async getCurrentHeight(): Promise<number> {
    const nodeInfo = await this.getNodeInfo();
    return nodeInfo.fullHeight;
  }

  private mapNodeInfo(data: any): NodeInfo {
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
  }

  private async getNodeInfoFromUrl(url: string): Promise<NodeInfo> {
    const response = await axios.get(`${this.normalizeNodeUrl(url)}/info`, {
      timeout: 10000,
      headers: this.headers
    });

    return this.mapNodeInfo(response.data);
  }

  // Get node info
  async getNodeInfo(): Promise<NodeInfo> {
    const errors: string[] = [];
    const primaryIndexedUrl = this.getPrimaryIndexedNodeUrl();

    try {
      return await this.getNodeInfoFromUrl(primaryIndexedUrl);
    } catch (error: any) {
      errors.push(`${primaryIndexedUrl}: ${error.message}`);
    }

    const indexedUrls = await this.getActiveIndexedNodeUrls(true).catch(() => []);
    for (const url of indexedUrls) {
      if (url === primaryIndexedUrl) {
        continue;
      }

      try {
        return await this.getNodeInfoFromUrl(url);
      } catch (error: any) {
        errors.push(`${url}: ${error.message}`);
      }
    }

    throw new Error(`Failed to get node info: ${errors.join('; ')}`);
  }

  async getStorageRentParameters(): Promise<StorageRentParameters> {
    const nodeInfo = await this.getNodeInfo();

    return {
      storageFeeFactor: nodeInfo.parameters.storageFeeFactor || this.config.rentFeePerByte,
      minValuePerByte: nodeInfo.parameters.minValuePerByte || this.config.minBoxValuePerByte,
      storagePeriodBlocks: this.config.storageRentPeriodBlocks
    };
  }

  async getPrimarySubmitHeight(): Promise<number> {
    const nodeInfo = await this.getNodeInfoFromUrl(this.getPrimarySubmitNodeUrl());
    return nodeInfo.fullHeight;
  }

  private normalizeNodeUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private getPrimaryIndexedNodeUrl(): string {
    return this.normalizeNodeUrl(this.config.ergoNodeUrl);
  }

  private getPrimarySubmitNodeUrl(): string {
    return this.normalizeNodeUrl(this.config.txSubmitNodeUrl);
  }

  private getExplorerApiBaseUrl(): string {
    const explorerUrl = this.normalizeNodeUrl(this.config.ergoExplorerUrl);
    return explorerUrl.endsWith('/api/v1') ? explorerUrl : `${explorerUrl}/api/v1`;
  }

  private async getExplorerTransaction(txId: string): Promise<any | null> {
    try {
      const response = await axios.get(`${this.getExplorerApiBaseUrl()}/transactions/${txId}`, {
        timeout: 10000
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }

      throw new Error(`Failed to get explorer transaction ${txId}: ${error.message}`);
    }
  }

  private async getExplorerBox(boxId: string): Promise<any | null> {
    try {
      const response = await axios.get(`${this.getExplorerApiBaseUrl()}/boxes/${boxId}`, {
        timeout: 10000
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }

      throw new Error(`Failed to get explorer box ${boxId}: ${error.message}`);
    }
  }

  private getConfiguredSubmitNodeUrls(): string[] {
    const urls = [this.getPrimarySubmitNodeUrl(), ...this.config.additionalSubmitNodeUrls.map(url => this.normalizeNodeUrl(url))];
    return Array.from(new Set(urls));
  }

  private decodeHtmlText(value: string): string {
    return value
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .trim();
  }

  private extractTableCells(row: string): string[] {
    const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
    return cells.map(cell => this.decodeHtmlText(cell));
  }

  private parseErgoNodeCandidates(html: string): SubmitNodeCandidate[] {
    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    const candidates = new Map<string, SubmitNodeCandidate>();

    for (const row of rows) {
      const cells = this.extractTableCells(row);
      const [address, name, appVersion, status] = cells;

      if (!address || !status || status.toLowerCase() !== 'reachable') {
        continue;
      }

      for (const url of this.getSubmitUrlCandidatesFromAddress(address)) {
        const normalizedUrl = this.normalizeNodeUrl(url);

        candidates.set(normalizedUrl, {
          url: normalizedUrl,
          source: 'ergonodes',
          ...(name && { name }),
          ...(appVersion && { appVersion })
        });
      }
    }

    return Array.from(candidates.values());
  }

  private getSubmitUrlCandidatesFromAddress(address: string): string[] {
    const parsed = this.extractHostAndPort(address);
    if (!parsed) {
      return [];
    }

    const urls = [`http://${parsed.host}:${this.config.nodeDiscoveryRestPort}`];
    if (parsed.port !== this.config.nodeDiscoveryRestPort) {
      urls.push(`http://${parsed.host}:${parsed.port}`);
    }

    return urls;
  }

  private extractHostAndPort(address: string): { host: string; port: number } | null {
    const trimmed = address.trim();
    const ipv6Match = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6Match?.[1] && ipv6Match[2]) {
      return { host: `[${ipv6Match[1]}]`, port: Number(ipv6Match[2]) };
    }

    const ipv4OrHostMatch = trimmed.match(/^([^:]+):(\d+)$/);
    if (ipv4OrHostMatch?.[1] && ipv4OrHostMatch[2]) {
      return { host: ipv4OrHostMatch[1], port: Number(ipv4OrHostMatch[2]) };
    }

    return null;
  }

  private async discoverSubmitNodeCandidatesFromErgoNodes(): Promise<SubmitNodeCandidate[]> {
    if (!this.config.enableNodeDiscovery) {
      return [];
    }

    const response = await axios.get(this.config.nodeDiscoveryUrl, {
      responseType: 'text',
      timeout: 10000
    });

    return this.parseErgoNodeCandidates(response.data);
  }

  async initializeNodeDiscovery(): Promise<void> {
    if (!this.config.enableNodeDiscovery) {
      await this.persistConfiguredSubmitNodes();
      return;
    }

    await this.persistConfiguredSubmitNodes();
    await this.getDiscoveredSubmitNodeUrls(true);
    await this.getActiveSubmitNodes(true);
  }

  private async persistConfiguredSubmitNodes(): Promise<void> {
    if (!this.database) {
      return;
    }

    await this.database.upsertSubmitNodeCandidates(this.getConfiguredSubmitNodeUrls(), 'configured');
  }

  private async getStoredSubmitNodeUrls(activeOnly: boolean = true): Promise<string[]> {
    if (!this.database) {
      return [];
    }

    const records = await this.database.getSubmitNodeRecords(activeOnly);
    return records.map(record => record.url);
  }

  private async getDiscoveredSubmitNodeUrls(forceRefresh: boolean = false): Promise<string[]> {
    const cache = this.discoveredSubmitNodeUrlsCache;
    if (!forceRefresh && cache && Date.now() - cache.updatedAt < this.config.nodeDiscoveryCacheMs) {
      return cache.urls;
    }

    if (!forceRefresh && cache) {
      return cache.urls;
    }

    try {
      const candidates = await this.discoverSubmitNodeCandidatesFromErgoNodes();
      const urls = candidates.map(candidate => candidate.url);
      if (this.database) {
        await this.database.upsertSubmitNodeCandidates(candidates, 'ergonodes');
      }
      this.discoveredSubmitNodeUrlsCache = { urls, updatedAt: Date.now() };
      return urls;
    } catch {
      const storedUrls = await this.getStoredSubmitNodeUrls(false).catch(() => []);
      return cache?.urls || storedUrls;
    }
  }

  private async probeSubmitNode(url: string): Promise<SubmitNode | null> {
    const normalizedUrl = this.normalizeNodeUrl(url);
    const startTime = Date.now();

    try {
      const response = await axios.get(`${normalizedUrl}/info`, {
        timeout: this.config.nodeProbeTimeout,
        headers: this.headers
      });

      const data = response.data;
      if (data.network !== this.config.networkType || !data.fullHeight) {
        await this.database?.recordSubmitNodeProbeFailure(
          normalizedUrl,
          `Invalid node info: network=${data.network ?? 'unknown'}, fullHeight=${data.fullHeight ?? 'missing'}`
        ).catch(() => undefined);
        return null;
      }

      const node: SubmitNode = {
        url: normalizedUrl,
        network: data.network,
        fullHeight: data.fullHeight,
        responseTimeMs: Date.now() - startTime,
        ...(data.isMining !== undefined && { isMining: data.isMining }),
        ...(data.name && { name: data.name }),
        ...(data.appVersion && { appVersion: data.appVersion })
      };

      await this.database?.recordSubmitNodeProbeSuccess(node).catch(() => undefined);
      return node;
    } catch (error: any) {
      this.inactiveSubmitNodeUrls.set(normalizedUrl, Date.now());
      await this.database?.recordSubmitNodeProbeFailure(normalizedUrl, error.message || String(error)).catch(() => undefined);
      return null;
    }
  }

  private isBlacklistedSubmitNode(url: string): boolean {
    const normalizedUrl = this.normalizeNodeUrl(url);
    const failedAt = this.inactiveSubmitNodeUrls.get(normalizedUrl);
    if (!failedAt) {
      return false;
    }

    if (Date.now() - failedAt >= this.config.nodeBlacklistMs) {
      this.inactiveSubmitNodeUrls.delete(normalizedUrl);
      return false;
    }

    return true;
  }

  private async isIndexedNode(url: string): Promise<boolean> {
    try {
      const response = await axios.get(`${this.normalizeNodeUrl(url)}/blockchain/indexedHeight`, {
        timeout: this.config.scanRequestTimeout,
        headers: this.headers
      });

      return typeof response.data?.indexedHeight === 'number';
    } catch {
      return false;
    }
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index];
        if (item === undefined) {
          continue;
        }

        results[index] = await mapper(item);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private async getKnownSubmitNodeUrls(): Promise<string[]> {
    const storedUrls = await this.getStoredSubmitNodeUrls().catch(() => []);

    return Array.from(new Set([
      ...this.getConfiguredSubmitNodeUrls(),
      ...storedUrls,
      ...(this.activeSubmitNodesCache?.nodes.map(node => node.url) || [])
    ]));
  }

  private filterActiveSubmitNodes(nodes: SubmitNode[]): SubmitNode[] {
    const bestHeight = nodes.reduce((height, node) => Math.max(height, node.fullHeight), 0);
    return nodes.filter(node => node.fullHeight >= bestHeight - 5);
  }

  async getActiveSubmitNodes(forceRefresh: boolean = false): Promise<SubmitNode[]> {
    const cacheMaxAgeMs = 10 * 60 * 1000;
    if (!forceRefresh && this.activeSubmitNodesCache && Date.now() - this.activeSubmitNodesCache.updatedAt < cacheMaxAgeMs) {
      return this.activeSubmitNodesCache.nodes;
    }

    await this.persistConfiguredSubmitNodes().catch(() => undefined);
    const discoveredUrls = await this.getDiscoveredSubmitNodeUrls(false);
    const knownUrls = await this.getKnownSubmitNodeUrls();
    const candidateUrls = Array.from(new Set([
      ...knownUrls,
      ...discoveredUrls.map(url => this.normalizeNodeUrl(url))
    ])).filter(url => !this.isBlacklistedSubmitNode(url));

    const nodes = (await this.mapWithConcurrency(
      candidateUrls,
      this.config.nodeProbeConcurrency,
      url => this.probeSubmitNode(url)
    )).filter((node): node is SubmitNode => node !== null);

    const activeNodes = this.filterActiveSubmitNodes(nodes);
    this.activeSubmitNodesCache = { nodes: activeNodes, updatedAt: Date.now() };
    return activeNodes;
  }

  async getBestSubmitNode(forceRefresh: boolean = false): Promise<SubmitNode> {
    const nodes = await this.getActiveSubmitNodes(forceRefresh);
    if (nodes.length === 0) {
      throw new Error('No active submit nodes available');
    }

    const bestHeight = nodes.reduce((height, node) => Math.max(height, node.fullHeight), 0);
    const bestHeightNodes = nodes.filter(node => node.fullHeight === bestHeight);
    const primarySubmitNode = bestHeightNodes.find(node => node.url === this.getPrimarySubmitNodeUrl());
    if (primarySubmitNode) {
      return primarySubmitNode;
    }

    bestHeightNodes.sort((a, b) => (a.responseTimeMs ?? Number.MAX_SAFE_INTEGER) - (b.responseTimeMs ?? Number.MAX_SAFE_INTEGER));

    return bestHeightNodes[0]!;
  }

  private async getActiveIndexedNodeUrls(forceRefresh: boolean = false): Promise<string[]> {
    const cacheMaxAgeMs = 10 * 60 * 1000;
    if (!forceRefresh && this.activeIndexedNodeUrlsCache && Date.now() - this.activeIndexedNodeUrlsCache.updatedAt < cacheMaxAgeMs) {
      return this.activeIndexedNodeUrlsCache.urls;
    }

    const submitNodes = await this.getActiveSubmitNodes(forceRefresh);
    const candidateUrls = Array.from(new Set([
      this.getPrimaryIndexedNodeUrl(),
      ...submitNodes.map(node => node.url)
    ]));

    const checks = await this.mapWithConcurrency(
      candidateUrls,
      this.config.nodeProbeConcurrency,
      async url => ({
        url,
        indexed: await this.isIndexedNode(url)
      })
    );

    const indexedUrls = checks
      .filter(check => check.indexed)
      .map(check => check.url);

    this.activeIndexedNodeUrlsCache = { urls: indexedUrls, updatedAt: Date.now() };
    return indexedUrls;
  }

  private async getBoxRangeFromIndexedNodes(offset: number, limit: number): Promise<string[]> {
    const primaryUrl = this.getPrimaryIndexedNodeUrl();
    try {
      const response = await axios.get(`${primaryUrl}/blockchain/box/range`, {
        params: { offset, limit },
        timeout: this.config.scanRequestTimeout,
        headers: this.headers
      });

      return this.getBoxIdsFromRangeResponse(response.data);
    } catch {
      // Fall through to discovered indexed nodes.
    }

    const urls = (await this.getActiveIndexedNodeUrls()).filter(url => url !== primaryUrl);
    const errors: string[] = [];

    for (const url of urls) {
      try {
        const response = await axios.get(`${url}/blockchain/box/range`, {
          params: { offset, limit },
          timeout: this.config.scanRequestTimeout,
          headers: this.headers
        });

        return this.getBoxIdsFromRangeResponse(response.data);
      } catch (error: any) {
        errors.push(`${url}: ${error.message}`);
      }
    }

    throw new Error(`Failed to get box range from indexed nodes: ${errors.join('; ')}`);
  }

  private getBoxIdsFromRangeResponse(data: any): string[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (Array.isArray(data?.boxIds)) {
      return data.boxIds;
    }

    return [];
  }

  private async getIndexedBoxById(boxId: string): Promise<BoxData | null> {
    const primaryUrl = this.getPrimaryIndexedNodeUrl();
    try {
      const response = await axios.get(`${primaryUrl}/blockchain/box/byId/${boxId}`, {
        timeout: this.config.scanRequestTimeout,
        headers: this.headers
      });

      return response.data;
    } catch {
      // Fall through to discovered indexed nodes.
    }

    const urls = (await this.getActiveIndexedNodeUrls()).filter(url => url !== primaryUrl);

    for (const url of urls) {
      try {
        const response = await axios.get(`${url}/blockchain/box/byId/${boxId}`, {
          timeout: this.config.scanRequestTimeout,
          headers: this.headers
        });

        return response.data;
      } catch {
        continue;
      }
    }

    return null;
  }

  private async getIndexedBoxByGlobalIndex(globalIndex: number): Promise<BoxData | null> {
    if (globalIndex < 0) {
      return null;
    }

    const primaryUrl = this.getPrimaryIndexedNodeUrl();
    try {
      const response = await axios.get(`${primaryUrl}/blockchain/box/byIndex/${globalIndex}`, {
        timeout: this.config.scanRequestTimeout,
        headers: this.headers
      });

      return response.data;
    } catch {
      // Fall through to discovered indexed nodes.
    }

    const urls = (await this.getActiveIndexedNodeUrls()).filter(url => url !== primaryUrl);

    for (const url of urls) {
      try {
        const response = await axios.get(`${url}/blockchain/box/byIndex/${globalIndex}`, {
          timeout: this.config.scanRequestTimeout,
          headers: this.headers
        });

        return response.data;
      } catch {
        continue;
      }
    }

    return null;
  }

  private async getLatestBoxGlobalIndex(): Promise<number> {
    const latestBoxIds = await this.getBoxRangeFromIndexedNodes(0, 1);
    const latestBoxId = latestBoxIds[0];
    if (!latestBoxId) {
      throw new Error('Indexed node returned no boxes at offset 0');
    }

    const latestBox = await this.getIndexedBoxById(latestBoxId);
    if (!latestBox || typeof latestBox.globalIndex !== 'number') {
      throw new Error(`Failed to resolve latest indexed box ${latestBoxId}`);
    }

    return latestBox.globalIndex;
  }

  private getIndexedOrderingHeight(box: BoxData): number {
    if (typeof box.inclusionHeight === 'number') {
      return box.inclusionHeight;
    }

    if (typeof box.settlementHeight === 'number') {
      return box.settlementHeight;
    }

    return box.creationHeight;
  }

  private async findFirstBoxIndexAtOrAfterInclusionHeight(targetHeight: number, latestGlobalIndex: number): Promise<number> {
    if (targetHeight <= 0) {
      return 0;
    }

    let low = 0;
    let high = latestGlobalIndex;
    let answer = latestGlobalIndex;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const box = await this.getIndexedBoxByGlobalIndex(mid);

      if (!box) {
        high = mid - 1;
        continue;
      }

      const orderingHeight = this.getIndexedOrderingHeight(box);
      if (orderingHeight >= targetHeight) {
        answer = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return answer;
  }

  private addIndexRange(indexes: Set<number>, start: number, end: number, latestGlobalIndex: number): void {
    const safeStart = Math.max(0, Math.floor(start));
    const safeEnd = Math.min(latestGlobalIndex, Math.floor(end));

    for (let index = safeStart; index <= safeEnd; index++) {
      indexes.add(index);
    }
  }

  private getSubmitErrorDetail(error: any): string {
    return error.response?.data?.detail || error.response?.data?.reason || error.message || String(error);
  }

  private getAlreadyInMempoolTxId(errorDetail: string, expectedTxId?: string): string | null {
    if (!/already in the mempool/i.test(errorDetail)) {
      return null;
    }

    return expectedTxId || errorDetail.match(/[0-9a-f]{64}/i)?.[0] || null;
  }

  async submitTransactionToNode(nodeUrl: string, signedTx: string, expectedTxId?: string): Promise<NodeSubmitResult> {
    const url = this.normalizeNodeUrl(nodeUrl);

    try {
      const response = await axios.post(`${url}/transactions`, signedTx, {
        headers: this.headers,
        timeout: 10000
      });

      return {
        url,
        txId: response.data,
        accepted: true
      };
    } catch (error: any) {
      const errorDetail = this.getSubmitErrorDetail(error);
      const alreadyAcceptedTxId = this.getAlreadyInMempoolTxId(errorDetail, expectedTxId);
      if (alreadyAcceptedTxId) {
        return {
          url,
          txId: alreadyAcceptedTxId,
          accepted: true
        };
      }

      return {
        url,
        accepted: false,
        error: errorDetail
      };
    }
  }

  async broadcastTransaction(
    signedTx: string,
    excludeUrls: string[] = [],
    targetHeight?: number,
    expectedTxId?: string
  ): Promise<BroadcastResult> {
    if (!this.config.enableSubmitBroadcast) {
      return { attempted: 0, accepted: [], rejected: [] };
    }

    const excluded = new Set(excludeUrls.map(url => this.normalizeNodeUrl(url)));
    const nodes = (await this.getActiveSubmitNodes(true))
      .filter(node => !excluded.has(node.url))
      .filter(node => targetHeight === undefined || node.fullHeight === targetHeight);
    const results = await this.mapWithConcurrency(
      nodes,
      this.config.nodeProbeConcurrency,
      node => this.submitTransactionToNode(node.url, signedTx, expectedTxId)
    );

    return {
      attempted: results.length,
      accepted: results.filter(result => result.accepted),
      rejected: results.filter(result => !result.accepted)
    };
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

  private async getBoxByIdFromNode(nodeUrl: string, boxId: string): Promise<BoxData | null> {
    try {
      const response = await axios.get(`${this.normalizeNodeUrl(nodeUrl)}/utxo/byId/${boxId}`, {
        timeout: 5000,
        headers: this.headers
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }

      throw new Error(`Failed to get box ${boxId} from ${nodeUrl}: ${error.message}`);
    }
  }

  // Calculate box size using Fleet SDK estimation
  private calculateBoxSize(box: BoxData): number {
    try {
      // Use Fleet SDK estimateBoxSize - the official Ergo library
      const fleetSize = estimateBoxSize(box);
      return fleetSize;
    } catch (error) {
      console.warn(`Failed to calculate box size for ${box.boxId}:`, error);
      // Fallback to standard box size
      return 49;
    }
  }

  private calculateStorageRentClaimableFee(
    box: BoxData,
    rentParams: StorageRentParameters
  ): {
    boxSize: number;
    rentFee: bigint;
    claimableFee: bigint;
    minRecreatedValue: bigint;
  } {
    const boxSize = this.calculateBoxSize(box);
    const rentFee = BigInt(boxSize) * BigInt(rentParams.storageFeeFactor);
    const boxValue = BigInt(box.value);
    const minRecreatedValue = BigInt(boxSize) * BigInt(rentParams.minValuePerByte);
    const hasAssets = (box.assets || []).length > 0;
    const canCollectAssetBox = this.config.storageRentMode === 'address' && hasAssets;

    if (canCollectAssetBox && this.config.enableAssetSubsidy) {
      return {
        boxSize,
        rentFee,
        minRecreatedValue,
        claimableFee: boxValue
      };
    }

    if (boxValue <= rentFee) {
      return {
        boxSize,
        rentFee,
        minRecreatedValue,
        claimableFee: 0n
      };
    }

    return {
      boxSize,
      rentFee,
      minRecreatedValue,
      claimableFee: boxValue > minRecreatedValue
        ? minBigInt(rentFee, boxValue - minRecreatedValue)
        : 0n
    };
  }

  private canClaimStorageRent(box: BoxData, rentParams: StorageRentParameters): boolean {
    const { claimableFee } = this.calculateStorageRentClaimableFee(box, rentParams);
    return claimableFee >= BigInt(this.config.minRentThreshold);
  }

  // Estimate VLQ (Variable Length Quantity) encoding size
  private estimateVLQSize(value: number): number {
    if (value < 128) return 1;
    if (value < 16384) return 2;
    if (value < 2097152) return 3;
    if (value < 268435456) return 4;
    return 5;
  }

  // Scan the moving storage-rent boundary and recent boxes with old declared creation heights.
  async scanForEligibleBoxes(
    currentHeight: number,
    rentParams: StorageRentParameters,
    startOffset: number = 0,
    targetBoxCount: number = 50
  ): Promise<{ boxesByHeight: Map<number, EligibleBox[]>, nextOffset: number }> {
    const boxesByHeight: Map<number, EligibleBox[]> = new Map();
    const spendHeight = currentHeight + 1;
    const minAge = rentParams.storagePeriodBlocks;
    const cutoffHeight = spendHeight - minAge;
    let nextOffset = 0;

    try {
      const latestGlobalIndex = await this.getLatestBoxGlobalIndex();
      const cutoffIndex = await this.findFirstBoxIndexAtOrAfterInclusionHeight(cutoffHeight, latestGlobalIndex);
      const maturityStart = cutoffIndex - this.config.scanIndexLookback;
      const maturityEnd = cutoffIndex + this.config.scanIndexLookahead;
      const recentStart = latestGlobalIndex - this.config.scanRecentIndexLookback;
      const indexSet = new Set<number>();

      this.addIndexRange(indexSet, maturityStart, maturityEnd, latestGlobalIndex);
      this.addIndexRange(indexSet, recentStart, latestGlobalIndex, latestGlobalIndex);

      const indexesToScan = Array.from(indexSet).sort((a, b) => a - b);
      nextOffset = Math.max(0, latestGlobalIndex - Math.max(0, Math.floor(maturityStart)));

      console.log(
        `Scanning storage-rent boundary. currentHeight=${currentHeight}, spendHeight=${spendHeight}, cutoffHeight=${cutoffHeight}, ` +
        `latestGlobalIndex=${latestGlobalIndex}, cutoffIndex=${cutoffIndex}, indexes=${indexesToScan.length}`
      );

      if (startOffset !== 0) {
        console.log(`Ignoring legacy range offset ${startOffset}; scan is now anchored by cutoff height`);
      }

      console.log(
        `Index windows: maturity=[${Math.max(0, Math.floor(maturityStart))}, ${Math.min(latestGlobalIndex, Math.floor(maturityEnd))}], ` +
        `recent=[${Math.max(0, Math.floor(recentStart))}, ${latestGlobalIndex}], futureWindow=${this.config.scanFutureBlockWindow} blocks`
      );

      const boxDetails = await this.mapWithConcurrency(
        indexesToScan,
        this.config.scanBoxDetailConcurrency,
        async globalIndex => {
          try {
            return await this.getIndexedBoxByGlobalIndex(globalIndex);
          } catch (error) {
            console.warn(`Error loading box by globalIndex=${globalIndex}:`, error);
            return null;
          }
        }
      );

      const candidates: EligibleBox[] = [];
      let boxesChecked = 0;
      let spentBoxes = 0;
      let notYetNear = 0;
      let belowThreshold = 0;
      let unspentBoxes = 0;

      for (const box of boxDetails) {
        if (!box) {
          continue;
        }

        boxesChecked++;

        if (box.spentTransactionId) {
          spentBoxes++;
          continue;
        }

        unspentBoxes++;

        const eligibleAtHeight = box.creationHeight + minAge;
        const blocksUntilEligible = eligibleAtHeight - spendHeight;

        if (blocksUntilEligible > this.config.scanFutureBlockWindow) {
          notYetNear++;
          continue;
        }

        const { boxSize, rentFee, claimableFee } = this.calculateStorageRentClaimableFee(box, rentParams);
        const boxValue = BigInt(box.value);

        if (claimableFee < BigInt(this.config.minRentThreshold)) {
          belowThreshold++;
          continue;
        }

        candidates.push({
          boxId: box.boxId,
          creationHeight: box.creationHeight,
          currentHeight,
          boxSize,
          value: boxValue,
          rentFee,
          status: 'queued',
          discoveredAt: new Date(),
          ergoTree: box.ergoTree,
          assets: box.assets ? box.assets.map((asset: any) => ({
            tokenId: asset.tokenId,
            amount: BigInt(asset.amount)
          })) : [],
          additionalRegisters: box.additionalRegisters || {},
          boxData: box
        });
      }

      candidates.sort((a, b) => {
        const aBlocksUntil = a.creationHeight + minAge - spendHeight;
        const bBlocksUntil = b.creationHeight + minAge - spendHeight;
        const aReadyRank = Math.max(aBlocksUntil, 0);
        const bReadyRank = Math.max(bBlocksUntil, 0);

        if (aReadyRank !== bReadyRank) {
          return aReadyRank - bReadyRank;
        }

        if (aBlocksUntil !== bBlocksUntil) {
          return bBlocksUntil - aBlocksUntil;
        }

        if (a.value === b.value) {
          return a.boxId.localeCompare(b.boxId);
        }

        return a.value > b.value ? -1 : 1;
      });

      const selectedCandidates = candidates.slice(0, targetBoxCount);

      for (const eligibleBox of selectedCandidates) {
        const height = eligibleBox.creationHeight;
        if (!boxesByHeight.has(height)) {
          boxesByHeight.set(height, []);
        }

        boxesByHeight.get(height)!.push(eligibleBox);
      }

      console.log(
        `Search complete: checked=${boxesChecked}, unspent=${unspentBoxes}, spent=${spentBoxes}, ` +
        `nearCandidates=${candidates.length}, selected=${selectedCandidates.length}, belowThreshold=${belowThreshold}, futureSkipped=${notYetNear}`
      );

      // Show next claimable boxes summary
      if (boxesByHeight.size > 0) {
        console.log('\n=== NEXT CLAIMABLE BOXES ===');
        const sortedHeights = Array.from(boxesByHeight.keys()).sort((a, b) => a - b);
        for (const height of sortedHeights) {
          const boxes = boxesByHeight.get(height)!;
          const claimableAtHeight = height + minAge;
          const blocksUntilClaimable = claimableAtHeight - spendHeight;
          const claimableSummary = blocksUntilClaimable <= 0 ? 'now' : `in ${blocksUntilClaimable} blocks`;
          console.log(`Height ${height}: ${boxes.length} boxes → claimable at height ${claimableAtHeight} (${claimableSummary})`);
          for (const box of boxes.slice(0, 3)) {
            console.log(`  ${box.boxId} value=${box.value} rentFee=${box.rentFee} status=${box.status}`);
          }
        }
        console.log('===============================\n');
      } else {
        console.log('No eligible or near-eligible storage-rent boxes found in the configured scan windows');
      }

    } catch (error) {
      throw new Error(`Failed to scan for eligible boxes: ${error}`);
    }

    return { boxesByHeight, nextOffset };
  }

  // Get wallet UTXOs for a given address
  async getWalletUtxos(address: string): Promise<any[]> {
    if (!address) {
      return [];
    }

    try {
      // Use blockchain API to find UTXOs for the address
      const response = await this.client.get(`/blockchain/box/unspent/byAddress/${address}`, {
        params: { limit: 100 }
      });
      return response.data;
    } catch (error: any) {
      const detail = error.response?.data?.detail || error.message || error;
      console.warn(`Failed to get wallet UTXOs for ${address}: ${detail}`);
      return [];
    }
  }

  // Validate boxes are still unspent
  async validateBoxes(boxIds: string[], currentHeight: number, rentParams: StorageRentParameters): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    const valid: string[] = [];
    const invalid: string[] = [];
    const spendHeight = currentHeight + 1;

    for (const boxId of boxIds) {
      try {
        const box = await this.getBoxById(boxId);
        if (!box || box.spentTransactionId) {
          invalid.push(boxId);
          continue;
        }

        const boxAge = spendHeight - box.creationHeight;
        if (boxAge < rentParams.storagePeriodBlocks || !this.canClaimStorageRent(box, rentParams)) {
          invalid.push(boxId);
          continue;
        }

        valid.push(boxId);
      } catch {
        invalid.push(boxId);
      }
    }

    return { valid, invalid };
  }

  async validateBoxesOnNode(
    nodeUrl: string,
    boxIds: string[],
    currentHeight: number,
    rentParams: StorageRentParameters
  ): Promise<{ valid: string[]; invalid: string[] }> {
    const spendHeight = currentHeight + 1;
    const checks = await Promise.all(boxIds.map(async boxId => {
      try {
        const box = await this.getBoxByIdFromNode(nodeUrl, boxId);
        const isValid = Boolean(box) &&
          !box?.spentTransactionId &&
          spendHeight - Number(box?.creationHeight ?? 0) >= rentParams.storagePeriodBlocks &&
          this.canClaimStorageRent(box!, rentParams);

        return { boxId, valid: isValid };
      } catch {
        return { boxId, valid: false };
      }
    }));

    return {
      valid: checks.filter(check => check.valid).map(check => check.boxId),
      invalid: checks.filter(check => !check.valid).map(check => check.boxId)
    };
  }

  async getBoxSpentTransactionId(boxId: string, options: { includeExplorer?: boolean } = {}): Promise<string | null> {
    const indexedBox = await this.getIndexedBoxById(boxId).catch(() => null);
    if (indexedBox?.spentTransactionId) {
      return indexedBox.spentTransactionId;
    }

    if (!options.includeExplorer) {
      return null;
    }

    const explorerBox = await this.getExplorerBox(boxId).catch(() => null);
    return explorerBox?.spentTransactionId || null;
  }

  // Submit transaction
  async submitTransaction(txBytes: string): Promise<string> {
    if (this.config.dryRun) {
      return 'dry-run-tx-id';
    }

    const result = await this.submitTransactionToNode(this.getPrimarySubmitNodeUrl(), txBytes);
    if (!result.accepted || !result.txId) {
      throw new Error(`Failed to submit transaction: ${result.error || 'unknown error'}`);
    }

    return result.txId;
  }

  // Check if transaction is confirmed
  async isTransactionConfirmed(txId: string, options: { includeExplorer?: boolean } = {}): Promise<boolean> {
    const isConfirmedTransaction = (transaction: any): boolean => (
      Boolean(transaction) && (
        Number(transaction.numConfirmations ?? 0) > 0 ||
        Boolean(transaction.blockId) ||
        Number(transaction.inclusionHeight ?? 0) > 0
      )
    );

    try {
      const response = await this.client.get(`/blockchain/transaction/byId/${txId}`);
      if (response.status === 200 && isConfirmedTransaction(response.data)) {
        return true;
      }
    } catch (error: any) {
      if (error.response?.status !== 404) {
        console.warn(`Failed to check transaction ${txId} on indexed node: ${error.message}`);
      }
    }

    if (!options.includeExplorer) {
      return false;
    }

    const explorerTransaction = await this.getExplorerTransaction(txId).catch(error => {
      console.warn(error.message || error);
      return null;
    });

    return isConfirmedTransaction(explorerTransaction);
  }

  // Get wallet balance from actual wallet UTXOs
  async getWalletBalance(address?: string): Promise<{ balance: bigint }> {
    try {
      if (!address) {
        return { balance: 0n };
      }

      const utxos = await this.getWalletUtxos(address);
      const balance = utxos.reduce((sum, box) => sum + BigInt(box.value), 0n);
      return { balance };
    } catch (error) {
      throw new Error(`Failed to get wallet balance: ${error}`);
    }
  }

}
