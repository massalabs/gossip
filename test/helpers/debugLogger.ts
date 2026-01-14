/**
 * Debug Logger Utility
 *
 * Provides enhanced logging and debugging capabilities for integration tests.
 * Saves screenshots, page state, console logs, IndexedDB contents, and network logs
 * to help debug test failures.
 */

import { Page, ConsoleMessage, Request } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export class DebugLogger {
  private testName: string;
  private debugDir: string;

  constructor(testName: string) {
    this.testName = testName;
    this.debugDir = join(process.cwd(), 'test-results', 'debug', testName);
  }

  /**
   * Ensure debug directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.debugDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Save a screenshot
   */
  async saveScreenshot(name: string, page: Page): Promise<void> {
    await this.ensureDir();
    const screenshotPath = join(this.debugDir, `${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  /**
   * Save page state (HTML snapshot)
   */
  async savePageState(name: string, page: Page): Promise<void> {
    await this.ensureDir();
    const html = await page.content();
    const filePath = join(this.debugDir, `${name}.html`);
    await writeFile(filePath, html, 'utf-8');
  }

  /**
   * Save console logs
   */
  async saveConsoleLogs(name: string, logs: ConsoleMessage[]): Promise<void> {
    await this.ensureDir();
    const logData = logs.map(log => ({
      type: log.type(),
      text: log.text(),
      location: log.location(),
    }));
    const filePath = join(this.debugDir, `${name}-console.json`);
    await writeFile(filePath, JSON.stringify(logData, null, 2), 'utf-8');
  }

  /**
   * Export IndexedDB contents
   * Note: This requires executing JavaScript in the page context
   */
  async saveIndexedDBState(
    name: string,
    dbName: string,
    page: Page
  ): Promise<void> {
    await this.ensureDir();
    try {
      // Execute in page context to access IndexedDB
      const dbData = await page.evaluate(async dbName => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(dbName);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction(db.objectStoreNames, 'readonly');
            const stores: Record<string, unknown[]> = {};

            Array.from(db.objectStoreNames).forEach(storeName => {
              const store = transaction.objectStore(storeName);
              const getAllRequest = store.getAll();
              getAllRequest.onsuccess = () => {
                stores[storeName] = getAllRequest.result;
              };
            });

            transaction.oncomplete = () => {
              resolve(stores);
            };
            transaction.onerror = () => {
              reject(transaction.error);
            };
          };
          request.onerror = () => {
            reject(request.error);
          };
        });
      }, dbName);

      const filePath = join(this.debugDir, `${name}-indexeddb.json`);
      await writeFile(filePath, JSON.stringify(dbData, null, 2), 'utf-8');
    } catch (error) {
      // If IndexedDB export fails, save error info
      const filePath = join(this.debugDir, `${name}-indexeddb-error.json`);
      await writeFile(
        filePath,
        JSON.stringify({ error: String(error), dbName }, null, 2),
        'utf-8'
      );
    }
  }

  /**
   * Save network request logs
   */
  async saveNetworkLogs(name: string, requests: Request[]): Promise<void> {
    await this.ensureDir();
    const networkData = await Promise.all(
      requests.map(async request => {
        const response = request.response();
        return {
          url: request.url(),
          method: request.method(),
          headers: request.headers(),
          postData: request.postData(),
          response: response
            ? {
                status: response.status(),
                statusText: response.statusText(),
                headers: response.headers(),
              }
            : null,
        };
      })
    );
    const filePath = join(this.debugDir, `${name}-network.json`);
    await writeFile(filePath, JSON.stringify(networkData, null, 2), 'utf-8');
  }

  /**
   * Generate comprehensive debug report
   */
  async createDebugReport(
    testName: string,
    error: Error,
    page: Page
  ): Promise<void> {
    await this.ensureDir();
    const report = {
      testName,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      timestamp: new Date().toISOString(),
      artifacts: {
        screenshot: `${testName}-failure.png`,
        pageState: `${testName}-failure.html`,
      },
    };

    // Save screenshot and page state
    await this.saveScreenshot(`${testName}-failure`, page);
    await this.savePageState(`${testName}-failure`, page);

    // Save report
    const filePath = join(this.debugDir, `${testName}-report.json`);
    await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  }
}
