import { logger } from '../utils/logs.js';
import { HttpStatusError, isFinalStatus } from './errors.js';

export { isFinalStatus };
/**
 * Base REST client with retry and timeout support.
 * Shared by RestMessageProtocol and RestAuthProtocol.
 */

export interface RestResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** The server's answer, when it refused the request. */
  httpError?: HttpStatusError;
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
          const error = new HttpStatusError(
            response.status,
            response.statusText
          );
          // The server refused the request itself: sending it again gets the
          // same answer. Only a timeout or rate limiting may pass later.
          if (isFinalStatus(response.status)) return failure(error);
          throw error;
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

    return failure(lastError);
  }
}

function failure<T>(error: Error | null): RestResponse<T> {
  return {
    success: false,
    error: error?.message || 'Request failed after all retry attempts',
    ...(error instanceof HttpStatusError && { httpError: error }),
  };
}
