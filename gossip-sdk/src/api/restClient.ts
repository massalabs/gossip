import { logger } from '../utils/logs.js';
import { HttpStatusError, isFinalStatus } from './errors.js';
import { debugLogEnabled, dlog } from '../utils/debugLog.js';
import { errFields, since } from '../utils/debugFields.js';

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
      const started = performance.now();
      let status: number | undefined;
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });
        status = response.status;

        if (!response.ok) {
          const error = new HttpStatusError(
            response.status,
            response.statusText
          );
          if (debugLogEnabled()) {
            logRequest(url, options, attempt, started, {
              status,
              final: isFinalStatus(response.status),
              ...errFields(error),
            });
          }
          // The server refused the request itself: sending it again gets the
          // same answer. Only a timeout or rate limiting may pass later.
          if (isFinalStatus(response.status)) return failure(error);
          throw error;
        }

        const data = await response.json();
        if (debugLogEnabled()) {
          logRequest(url, options, attempt, started, { status }, data);
        }
        return { success: true, data };
      } catch (error) {
        lastError = error as Error;
        if (debugLogEnabled() && !(error instanceof HttpStatusError)) {
          logRequest(url, options, attempt, started, {
            status,
            aborted: controller.signal.aborted,
            ...errFields(error),
          });
        }
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

/**
 * One `api.request` line per attempt: method, path, status, duration, bytes
 * out and in, attempt number; the full URL and both bodies as content.
 */
function logRequest(
  url: string,
  options: RequestInit,
  attempt: number,
  started: number,
  outcome: Record<string, unknown>,
  data?: unknown
): void {
  try {
    const body = typeof options.body === 'string' ? options.body : undefined;
    const answer = data === undefined ? undefined : JSON.stringify(data);
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.split('?')[0];
    }
    const failed = 'err' in outcome;
    dlog(
      'api',
      'api.request',
      {
        method: options.method ?? 'GET',
        path,
        attempt,
        out: body?.length ?? 0,
        ...(answer !== undefined && { in: answer.length }),
        ...outcome,
      },
      {
        lvl: failed ? 'warn' : 'debug',
        dur: since(started),
        c: { url, req: body, res: answer },
      }
    );
  } catch {
    // Never let a debug line change a request.
  }
}

function failure<T>(error: Error | null): RestResponse<T> {
  return {
    success: false,
    error: error?.message || 'Request failed after all retry attempts',
    ...(error instanceof HttpStatusError && { httpError: error }),
  };
}
