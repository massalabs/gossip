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
export { RestMessageProtocol } from './rest.js';
export { MessageProtocol } from './mock.js';

import type { IMessageProtocol } from './types.js';
import {
  defaultMessageProtocol,
  protocolConfig,
  type MessageProtocolType,
} from '../../config/protocol.js';

import { RestMessageProtocol } from './rest.js';
import { MessageProtocol } from './mock.js';

/**
 * Factory function to create message protocol instances
 */
export function createMessageProtocol(
  type: MessageProtocolType = defaultMessageProtocol,
  config?: Partial<{ baseUrl: string; timeout: number; retryAttempts: number }>
): IMessageProtocol {
  switch (type) {
    case 'rest': {
      return new RestMessageProtocol(
        config?.baseUrl || protocolConfig.baseUrl,
        config?.timeout || 10000,
        config?.retryAttempts || 3
      );
    }
    case 'mock': {
      return new MessageProtocol(
        config?.baseUrl || protocolConfig.baseUrl,
        config?.timeout || 10000,
        config?.retryAttempts || 3
      );
    }
    default:
      throw new Error(`Unsupported message protocol type: ${type}`);
  }
}

export const restMessageProtocol = createMessageProtocol();
