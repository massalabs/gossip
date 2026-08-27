import { logger } from '../utils/logs.js';
/**
 * Base REST client with retry and timeout support.
 * Shared by RestMessageProtocol and RestAuthProtocol.
 */

export interface RestResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export class RestClient {
  constructor(
    protected baseUrl: string,
    protected timeout: number = 10000,
    protected retryAttempts: number = 3
  ) {}

  protected async makeRequest<T>(
    url: string,
    options: RequestInit
  ): Promise<RestResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Request attempt ${attempt} failed:`, error);

        if (attempt < this.retryAttempts) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Request failed after all retry attempts',
    };
  }
}
