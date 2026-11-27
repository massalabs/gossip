/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Works in both browser and Node.js environments.
 *
 * WASM is loaded via the web target build with runtime detection:
 * - Browser: init() uses import.meta.url + fetch
 * - Node.js / Jiti: init(bytes) reads the .wasm file from disk
 *
 * @example
 * ```typescript
 * import { gossipSdk } from '@massalabs/gossip-sdk';
 *
 * await gossipSdk.init({ db, protocolBaseUrl: 'https://api.example.com' });
 * await gossipSdk.openSession({ mnemonic: '...' });
 * await gossipSdk.messages.send(contactId, 'Hello!');
 * ```
 *
 * @packageDocumentation
 */

export * from './core/SdkEventEmitter.js';
export * from './api/index.js';
export * from './crypto/index.js';
export * from './gossip.js';
export * from './utils/index.js';
export * from './wasm/index.js';
export * from './db/db.js';
export * from './db/queries/index.js';
export * from './db/sqlite.js';
export { SELF_CONTACT_ID } from './services/selfMessage.js';
export { GroupService } from './services/groups.js';
export {
  ConversationService,
  MigrationUnavailableError,
} from './services/conversations.js';
export type { AddAsContactResult } from './services/conversations.js';
export type {
  GroupId,
  GroupSummary,
  GroupInvitation,
  GroupMessage,
  GroupMessageBody,
  GroupMessageContent,
  GroupReaction,
  GroupLine,
  GroupTimelineItem,
  GroupChange,
  GroupChangeKind,
  GroupMemberStatus,
  GroupPublished,
  LeaveChoice,
  GroupMessageRef,
  GroupEpoch,
  GroupLocalEdit,
  GroupMessageLimits,
  GroupEpochTimer,
} from './services/groups.js';
export type { DiscussionStartOptions } from './services/discussion.js';
export {
  GROUP_MAX_SCHEDULE_MS,
  GROUP_DEVICE_KEY,
  EARLIER_FORMAT_VERSION,
  GroupMessageTooLargeError,
  GroupInvalidReactionError,
  GROUP_MAX_EMOJI_BYTES,
  GROUP_TIMER_28_DAYS_MS,
  retentionToMessageTimer,
} from './services/groups.js';
