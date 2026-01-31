/**
 * StorageWorkerClient - Communicates with the storage worker from the main thread.
 *
 * This client provides a Promise-based API for interacting with the worker,
 * handling message passing and response correlation.
 */

export interface WorkerStatus {
  initialized: boolean;
  sessionUnlocked: boolean;
  dbOpen: boolean;
  vfsStats: { readCount: number; writeCount: number } | null;
}

export interface SqlResult {
  success: boolean;
  rows?: unknown[][];
  columns?: string[];
  error?: string;
  changes?: number;
  lastInsertRowid?: number;
}

export interface VizEvent {
  kind: string;
  timestamp: number;
  offset?: number;
  size?: number;
  durationMs?: number;
  fileId?: number;
  success?: boolean;
  slotIndex?: number;
}

type VizEventHandler = (event: VizEvent) => void;
type LogHandler = (message: string) => void;

export class StorageWorkerClient {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private vizHandlers = new Set<VizEventHandler>();
  private logHandlers = new Set<LogHandler>();
  private sessionSlots: number[] = [];

  constructor() {}

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    if (this.worker) {
      return;
    }

    // Create worker from the storage-worker.ts file
    this.worker = new Worker(
      new URL('../../../storage-worker.ts', import.meta.url),
      { type: 'module' }
    );

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Initialize the worker
    await this.send('init');
  }

  /**
   * Stop the worker
   */
  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.worker !== null;
  }

  // ============ Session Management ============

  async createSession(
    password: string
  ): Promise<{ success: boolean; error?: string }> {
    return await this.send('create-session', { password });
  }

  async unlockSession(
    password: string
  ): Promise<{ success: boolean; error?: string }> {
    return await this.send('unlock-session', { password });
  }

  async lockSession(): Promise<{ success: boolean }> {
    return await this.send('lock-session');
  }

  async getStatus(): Promise<WorkerStatus> {
    return await this.send('status');
  }

  // ============ SQL Execution ============

  async exec(sql: string): Promise<SqlResult> {
    return await this.send('exec', { sql });
  }

  /**
   * Execute SQL and return typed rows
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await this.exec(sql);
    if (!result.success) {
      throw new Error(result.error || 'Query failed');
    }
    // The worker returns rows as arrays, we need column names to convert to objects
    // For now, return raw rows - in production, we'd parse column names from SQL
    return (result.rows || []) as unknown as T[];
  }

  /**
   * Execute multiple statements
   */
  async execBatch(statements: string[]): Promise<void> {
    for (const sql of statements) {
      const result = await this.exec(sql);
      if (!result.success) {
        throw new Error(result.error || 'Batch execution failed');
      }
    }
  }

  // ============ Visualization ============

  async enableVisualization(): Promise<void> {
    await this.send('enable-viz');
  }

  async disableVisualization(): Promise<void> {
    await this.send('disable-viz');
  }

  async getSessionSlots(): Promise<number[]> {
    await this.send('get-session-slots');
    return this.sessionSlots;
  }

  onVizEvent(handler: VizEventHandler): () => void {
    this.vizHandlers.add(handler);
    return () => this.vizHandlers.delete(handler);
  }

  onLog(handler: LogHandler): () => void {
    this.logHandlers.add(handler);
    return () => this.logHandlers.delete(handler);
  }

  // ============ Internal ============

  private async send<T = unknown>(
    type: string,
    data?: Record<string, unknown>
  ): Promise<T> {
    if (!this.worker) {
      throw new Error('Worker not started');
    }

    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.worker!.postMessage({ type, id, ...data });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Worker request timed out: ${type}`));
        }
      }, 30000);
    });
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;

    // Handle viz events
    if (data.type === 'viz-event') {
      this.vizHandlers.forEach(handler => handler(data as VizEvent));
      return;
    }

    // Handle log messages
    if (data.type === 'log') {
      this.logHandlers.forEach(handler => handler(data.message));
      return;
    }

    // Handle session slots
    if (data.type === 'session-slots') {
      this.sessionSlots = data.slots || [];
      return;
    }

    // Handle response to a request
    if (data.type?.endsWith('-result') && data.id !== undefined) {
      const pending = this.pendingRequests.get(data.id);
      if (pending) {
        this.pendingRequests.delete(data.id);
        // Remove type and id from response
        const { type: _, id: __, ...result } = data;
        pending.resolve(result);
      }
    }
  }

  private handleError(error: ErrorEvent): void {
    console.error('[StorageWorkerClient] Worker error:', error);
    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Worker error: ' + error.message));
    });
    this.pendingRequests.clear();
  }
}

/**
 * Singleton instance for the default worker client
 */
let defaultClient: StorageWorkerClient | null = null;

export function getStorageWorkerClient(): StorageWorkerClient {
  if (!defaultClient) {
    defaultClient = new StorageWorkerClient();
  }
  return defaultClient;
}

export function resetStorageWorkerClient(): void {
  if (defaultClient) {
    defaultClient.stop();
    defaultClient = null;
  }
}
