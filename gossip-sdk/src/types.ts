/**
 * SDK Types
 *
 * Re-export types from the main application for SDK consumers
 */

// Re-export database types
export type {
  Contact,
  Message,
  Discussion,
  UserProfile,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
  AuthMethod,
} from '../../src/db';

export {
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  DiscussionDirection,
  MessageType,
} from '../../src/db';

// Re-export service types
export type { PublicKeyResult } from '../../src/services/auth';

export type {
  MessageResult,
  SendMessageResult,
} from '../../src/services/message';

export type { AnnouncementReceptionResult } from '../../src/services/announcement';

// Re-export utility types
export type {
  UpdateContactNameResult,
  DeleteContactResult,
} from '../../src/utils/contacts';

export type { UpdateDiscussionNameResult } from '../../src/utils/discussions';
