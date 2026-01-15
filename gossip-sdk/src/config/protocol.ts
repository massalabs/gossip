/**
 * Protocol API Configuration
 *
 * Centralized configuration for the message protocol API endpoints.
 * This allows easy switching between different protocol implementations.
 */

export interface ProtocolConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
}

// Default API URL - can be overridden at runtime
const DEFAULT_API_URL = 'https://api.usegossip.com';

// Mutable config that can be updated at runtime
let currentBaseUrl: string | null = null;

function buildProtocolApiBaseUrl(): string {
  // If runtime override is set, use it
  if (currentBaseUrl !== null) {
    return currentBaseUrl;
  }

  // Try to get from environment variable (Vite)
  let apiUrl: string | undefined;
  try {
    // Check if import.meta.env is available (Vite environment)
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.VITE_GOSSIP_API_URL
    ) {
      apiUrl = import.meta.env.VITE_GOSSIP_API_URL;
    }
  } catch {
    // import.meta.env not available (Node.js without Vite)
  }

  // Check process.env for Node.js environment
  if (
    !apiUrl &&
    typeof process !== 'undefined' &&
    process.env?.GOSSIP_API_URL
  ) {
    apiUrl = process.env.GOSSIP_API_URL;
  }

  // Fall back to default
  if (!apiUrl) apiUrl = DEFAULT_API_URL;

  // Normalize trailing slashes to avoid `//api`
  const trimmed = apiUrl.replace(/\/+$/, '');
  return `${trimmed}/api`;
}

export const protocolConfig: ProtocolConfig = {
  get baseUrl() {
    return buildProtocolApiBaseUrl();
  },
  timeout: 10000,
  retryAttempts: 3,
};

export enum MessageProtocolType {
  REST = 'rest',
  MOCK = 'mock',
}

export const defaultMessageProtocol: MessageProtocolType =
  MessageProtocolType.REST;

/**
 * Set the base URL for the protocol API at runtime.
 * This overrides environment variables and defaults.
 *
 * @param baseUrl - The base URL to use (e.g., 'https://api.example.com/api')
 *
 * @example
 * ```typescript
 * import { setProtocolBaseUrl } from 'gossip-sdk';
 *
 * // Set custom API endpoint
 * setProtocolBaseUrl('https://my-server.com/api');
 * ```
 */
export function setProtocolBaseUrl(baseUrl: string): void {
  currentBaseUrl = baseUrl;
}

/**
 * Reset the base URL to use environment variables or defaults.
 */
export function resetProtocolBaseUrl(): void {
  currentBaseUrl = null;
}
