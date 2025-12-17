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

function buildProtocolApiBaseUrl(): string {
  let apiUrl: string | undefined = import.meta.env.VITE_GOSSIP_API_URL;

  if (!apiUrl) apiUrl = 'http://localhost:3000';

  // Normalize trailing slashes to avoid `//api`
  const trimmed = apiUrl.replace(/\/+$/, '');
  return `${trimmed}/api`;
}

export const protocolConfig: ProtocolConfig = {
  baseUrl: buildProtocolApiBaseUrl(),
  timeout: 10000,
  retryAttempts: 3,
};

export enum MessageProtocolType {
  REST = 'rest',
  MOCK = 'mock',
}

export const defaultMessageProtocol: MessageProtocolType =
  MessageProtocolType.REST;
