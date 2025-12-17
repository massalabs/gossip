export type {
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
} from './messageProtocol/types';
export { RestMessageProtocol } from './messageProtocol/rest';
export { MockMessageProtocol } from './messageProtocol/mock';
import type { IMessageProtocol } from './messageProtocol/types';
import {
  defaultMessageProtocol,
  protocolConfig,
  type MessageProtocolType,
} from '../config/protocol';

import { RestMessageProtocol } from './messageProtocol/rest';
import { MockMessageProtocol } from './messageProtocol/mock';
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
        protocolConfig.baseUrl,
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
