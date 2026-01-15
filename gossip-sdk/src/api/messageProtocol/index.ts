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
} from './types';
export { RestMessageProtocol } from './rest';
export { MockMessageProtocol } from './mock';

import type { IMessageProtocol } from './types';
import {
  defaultMessageProtocol,
  protocolConfig,
  type MessageProtocolType,
} from '../../config/protocol';

import { RestMessageProtocol } from './rest';
import { MockMessageProtocol } from './mock';

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
      return new MockMessageProtocol();
    }
    default:
      throw new Error(`Unsupported message protocol type: ${type}`);
  }
}

export const restMessageProtocol = createMessageProtocol();
