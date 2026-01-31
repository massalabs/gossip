/**
 * SDK Types
 *
 * Re-exports types from internal SDK modules for external consumers.
 */

// Database entity types
export type {
  Contact,
  Message,
  Discussion,
  UserProfile,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
  AuthMethod,
} from './db';

// Database enums
export {
  MessageDirection,
  MessageStatus,
  DiscussionDirection,
  MessageType,
} from './db';

// Service result types
export type { PublicKeyResult } from './services/auth';
export type { MessageResult, SendMessageResult } from './services/message';
export type { AnnouncementReceptionResult } from './services/announcement';

// Utility result types
export type {
  UpdateContactNameResult,
  DeleteContactResult,
} from './utils/contacts';
export type { UpdateDiscussionNameResult } from './utils/discussions';

// API types
export type {
  IMessageProtocol,
  EncryptedMessage,
  MessageProtocolResponse,
  BulletinItem,
} from './api/messageProtocol/types';

// Wallet types (pure TypeScript types for the app to use)
export type Ticker = string;

export interface TokenMeta {
  address: string;
  name: string;
  ticker: Ticker;
  icon: string;
  decimals: number;
  isNative: boolean;
}

export interface TokenState extends TokenMeta {
  balance: bigint | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface FeeConfig {
  type: 'preset' | 'custom';
  preset?: 'low' | 'standard' | 'high';
  customFee?: string;
}
