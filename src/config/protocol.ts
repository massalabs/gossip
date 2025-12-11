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

export const protocolConfig: ProtocolConfig = {
  baseUrl: import.meta.env.VITE_PROTOCOL_API_URL
    ? `${import.meta.env.VITE_PROTOCOL_API_URL}/api`
    : 'http://localhost:3000/api',
  timeout: 10000,
  retryAttempts: 3,
};

export enum MessageProtocolType {
  REST = 'rest',
  MOCK = 'mock',
}

export const defaultMessageProtocol: MessageProtocolType =
  MessageProtocolType.REST;
