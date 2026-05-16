import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { Database } from '../database';
import { Config, SubmitNode } from '../types';
import { ErgoNodeService } from './ergoNode';

interface UiLogger {
  info(message: string, context?: any): void;
  warn(message: string, context?: any): void;
  error(message: string, context?: any): void;
}

interface UiQueueGroup {
  creationHeight: number;
  boxCount: number;
  claimableAtHeight: number;
  blocksUntilClaimable: number;
  totalRentNano: string;
  totalValueNano: string;
  assetCount: number;
  statusCounts: Record<string, number>;
  sampleBoxIds: string[];
  lastDiscoveredAt: string;
}

interface UiTransaction {
  txId: string;
  status: string;
  boxCount: number;
  totalRentNano: string;
  transactionFeeNano: string;
  createdAt: string;
}

interface UiMetrics {
  totalBoxesScanned: number;
  eligibleBoxesFound: number;
  totalRentCollected: string;
  totalTransactionsFees: string;
  successfulTransactions: number;
  failedTransactions: number;
  lastScanHeight: number;
  lastScanTime: string;
  walletBalance: string;
}

interface UiSubmitNode {
  url: string;
  network: string;
  fullHeight: number;
  responseTimeMs: number | null;
  isMining: boolean | null;
  name: string | null;
}

interface UiSnapshot {
  generatedAt: string;
  indexedHeight: number | null;
  spendHeight: number | null;
  bestSubmitHeight: number | null;
  bestSubmitNode: UiSubmitNode | null;
  activeSubmitNodes: UiSubmitNode[];
  statusCounts: Record<string, number>;
  metrics: UiMetrics;
  queue: UiQueueGroup[];
  recentTransactions: UiTransaction[];
  botState: Record<string, string>;
  errors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSubmitNodeView(node: SubmitNode): UiSubmitNode {
  return {
    url: node.url,
    network: node.network,
    fullHeight: node.fullHeight,
    responseTimeMs: node.responseTimeMs ?? null,
    isMining: node.isMining ?? null,
    name: node.name ?? null
  };
}

function addCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] || 0) + 1;
}

export class UIServer {
  private readonly config: Config;
  private readonly database: Database;
  private readonly ergoNode: ErgoNodeService;
  private readonly logger: UiLogger;
  private readonly clients = new Set<WebSocket>();
  private readonly dashboardPath = path.resolve(process.cwd(), 'src', 'ui', 'dashboard.html');
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private snapshotInFlight: Promise<UiSnapshot> | null = null;
  private dashboardHtml: string | null = null;

  constructor(config: Config, database: Database, ergoNode: ErgoNodeService, logger: UiLogger) {
    this.config = config;
    this.database = database;
    this.ergoNode = ergoNode;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch(error => {
        this.logger.error('UI request failed', { component: 'ui', error: errorMessage(error) });
        this.sendText(res, 500, 'UI request failed');
      });
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', socket => this.handleSocket(socket));

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.uiPort, this.config.uiHost);
    });

    this.refreshTimer = setInterval(() => {
      this.broadcastSnapshot().catch(error => {
        this.logger.warn('UI snapshot broadcast failed', { component: 'ui', error: errorMessage(error) });
      });
    }, this.config.uiRefreshMs);

    this.logger.info(`UI dashboard listening at http://${this.config.uiHost}:${this.config.uiPort}`, { component: 'ui' });
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>(resolve => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method !== 'GET') {
      this.sendText(res, 405, 'Method not allowed');
      return;
    }

    if (requestUrl.pathname === '/api/status') {
      this.sendJson(res, await this.getSnapshot());
      return;
    }

    if (requestUrl.pathname === '/health') {
      this.sendJson(res, { ok: true });
      return;
    }

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/dashboard.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(this.getDashboardHtml());
      return;
    }

    this.sendText(res, 404, 'Not found');
  }

  private handleSocket(socket: WebSocket): void {
    this.clients.add(socket);

    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));

    this.sendSnapshot(socket).catch(error => {
      this.logger.warn('Initial UI snapshot failed', { component: 'ui', error: errorMessage(error) });
    });
  }

  private async broadcastSnapshot(): Promise<void> {
    if (this.clients.size === 0) {
      return;
    }

    const snapshot = await this.getSnapshot();
    const payload = JSON.stringify(snapshot);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private async sendSnapshot(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(await this.getSnapshot()));
  }

  private async getSnapshot(): Promise<UiSnapshot> {
    if (this.snapshotInFlight) {
      return this.snapshotInFlight;
    }

    this.snapshotInFlight = this.buildSnapshot().finally(() => {
      this.snapshotInFlight = null;
    });

    return this.snapshotInFlight;
  }

  private async buildSnapshot(): Promise<UiSnapshot> {
    const errors: string[] = [];
    const [metrics, boxes, transactions, botStates] = await Promise.all([
      this.database.getBotMetrics(),
      this.database.getEligibleBoxes(),
      this.database.getTransactions(),
      this.database.getAllBotState()
    ]);

    const indexedHeight = await this.ergoNode.getCurrentHeight().catch(error => {
      errors.push(`indexed node: ${errorMessage(error)}`);
      return null;
    });

    const activeSubmitNodes = (await this.ergoNode.getActiveSubmitNodes(false).catch(error => {
      errors.push(`submit nodes: ${errorMessage(error)}`);
      return [];
    }))
      .slice()
      .sort((a, b) => {
        const byHeight = b.fullHeight - a.fullHeight;
        if (byHeight !== 0) {
          return byHeight;
        }
        return (a.responseTimeMs ?? Number.MAX_SAFE_INTEGER) - (b.responseTimeMs ?? Number.MAX_SAFE_INTEGER);
      })
      .map(toSubmitNodeView);

    const bestSubmitNode = activeSubmitNodes[0] ?? null;
    const spendHeight = indexedHeight === null ? null : indexedHeight + 1;
    const statusCounts: Record<string, number> = {};

    for (const box of boxes) {
      addCount(statusCounts, box.status);
    }

    return {
      generatedAt: new Date().toISOString(),
      indexedHeight,
      spendHeight,
      bestSubmitHeight: bestSubmitNode?.fullHeight ?? null,
      bestSubmitNode,
      activeSubmitNodes,
      statusCounts,
      metrics: {
        totalBoxesScanned: metrics.totalBoxesScanned,
        eligibleBoxesFound: metrics.eligibleBoxesFound,
        totalRentCollected: metrics.totalRentCollected.toString(),
        totalTransactionsFees: metrics.totalTransactionsFees.toString(),
        successfulTransactions: metrics.successfulTransactions,
        failedTransactions: metrics.failedTransactions,
        lastScanHeight: metrics.lastScanHeight,
        lastScanTime: metrics.lastScanTime.toISOString(),
        walletBalance: metrics.walletBalance.toString()
      },
      queue: this.groupQueuedBoxes(boxes, spendHeight),
      recentTransactions: transactions.slice(0, 25).map(tx => ({
        txId: tx.txId,
        status: tx.status,
        boxCount: tx.boxIds.length,
        totalRentNano: tx.totalRentCollected.toString(),
        transactionFeeNano: tx.transactionFee.toString(),
        createdAt: tx.createdAt.toISOString()
      })),
      botState: Object.fromEntries(botStates.map(state => [state.key, state.value])),
      errors
    };
  }

  private groupQueuedBoxes(boxes: Awaited<ReturnType<Database['getEligibleBoxes']>>, spendHeight: number | null): UiQueueGroup[] {
    const groups = new Map<number, UiQueueGroup>();
    const liveBoxes = boxes.filter(box => {
      if (box.status !== 'queued') {
        return false;
      }

      const currentSpendHeight = spendHeight ?? box.currentHeight + 1;
      return box.creationHeight + this.config.minStorageRentAgeBlocks >= currentSpendHeight;
    });

    for (const box of liveBoxes) {
      const claimableAtHeight = box.creationHeight + this.config.minStorageRentAgeBlocks;
      const currentSpendHeight = spendHeight ?? box.currentHeight + 1;
      let group = groups.get(box.creationHeight);

      if (!group) {
        group = {
          creationHeight: box.creationHeight,
          boxCount: 0,
          claimableAtHeight,
          blocksUntilClaimable: claimableAtHeight - currentSpendHeight,
          totalRentNano: '0',
          totalValueNano: '0',
          assetCount: 0,
          statusCounts: {},
          sampleBoxIds: [],
          lastDiscoveredAt: box.discoveredAt.toISOString()
        };
        groups.set(box.creationHeight, group);
      }

      group.boxCount += 1;
      group.totalRentNano = (BigInt(group.totalRentNano) + box.rentFee).toString();
      group.totalValueNano = (BigInt(group.totalValueNano) + box.value).toString();
      group.assetCount += box.assets.length;
      addCount(group.statusCounts, box.status);
      if (box.discoveredAt > new Date(group.lastDiscoveredAt)) {
        group.lastDiscoveredAt = box.discoveredAt.toISOString();
      }
      if (group.sampleBoxIds.length < 5) {
        group.sampleBoxIds.push(box.boxId);
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => {
        return Math.max(a.blocksUntilClaimable, 0) - Math.max(b.blocksUntilClaimable, 0)
          || a.claimableAtHeight - b.claimableAtHeight
          || a.creationHeight - b.creationHeight;
      })
      .slice(0, 30);
  }

  private getDashboardHtml(): string {
    if (this.dashboardHtml) {
      return this.dashboardHtml;
    }

    this.dashboardHtml = fs.readFileSync(this.dashboardPath, 'utf8');
    return this.dashboardHtml;
  }

  private sendJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(value));
  }

  private sendText(res: ServerResponse, statusCode: number, body: string): void {
    if (res.headersSent) {
      return;
    }

    res.writeHead(statusCode, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(body);
  }
}
