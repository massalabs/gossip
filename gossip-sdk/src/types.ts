/**
 * SDK Types
 *
 * Re-exports types from the main application for SDK consumers.
 * This provides a stable interface for types used across the SDK.
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
} from '@/db';

// Database enums
export {
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  DiscussionDirection,
  MessageType,
} from '@/db';

// Service result types
export type { PublicKeyResult } from '@/services/auth';
export type { MessageResult, SendMessageResult } from '@/services/message';
export type { AnnouncementReceptionResult } from '@/services/announcement';

// Utility result types
export type {
  UpdateContactNameResult,
  DeleteContactResult,
} from '@/utils/contacts';
export type { UpdateDiscussionNameResult } from '@/utils/discussions';
