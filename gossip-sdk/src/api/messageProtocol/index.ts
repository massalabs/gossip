/**
 * Message Protocol Module
 *
 * Factory functions and exports for message protocol implementations.
 */

export type {
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
  BulletinItem,
} from './types.js';
import type { IMessageProtocol } from './types.js';
import { protocolConfig } from '../../config/protocol.js';
import { RestMessageProtocol } from './rest.js';

/**
 * Factory function to create message protocol instances
 */
export function createMessageProtocol(
  config?: Partial<{ baseUrl: string; timeout: number; retryAttempts: number }>
): IMessageProtocol {
  return new RestMessageProtocol(
    config?.baseUrl ?? protocolConfig.baseUrl,
    config?.timeout ?? protocolConfig.timeout,
    config?.retryAttempts ?? protocolConfig.retryAttempts
  );
}

export const restMessageProtocol = createMessageProtocol();
export { RestMessageProtocol } from './rest.js';
