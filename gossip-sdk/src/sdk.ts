/**
 * GossipSdk - Unified SDK facade
 *
 * Provides a clean, unified API for all gossip functionality.
 * All services and utilities are accessible through a single SDK instance.
 *
 * @example
 * ```typescript
 * import { createGossipSdk } from 'gossip-sdk';
 *
 * // Create SDK instance after user login with event handlers
 * const sdk = createGossipSdk(db, messageProtocol, session, {
 *   onMessageReceived: (message) => {
 *     // Update your app's state
 *     messageStore.addMessage(message);
 *   },
 *   onDiscussionRequest: (discussion) => {
 *     // Show notification, update UI
 *     discussionStore.addDiscussion(discussion);
 *   },
 * });
 *
 * // Access services
 * await sdk.discussion.initialize(contact);
 * await sdk.message.sendMessage(message);
 * await sdk.announcement.fetchAndProcessAnnouncements();
 *
 * // Access user info
 * console.log(sdk.userId);
 *
 * // Access utilities
 * const isValid = sdk.utils.validateUserId(someId);
 * ```
 */

import { GossipDatabase } from './db';
import { IMessageProtocol } from './api/messageProtocol';
import { SessionModule } from './wasm/session';
import { AnnouncementService } from './services/announcement';
import { DiscussionService } from './services/discussion';
import { MessageService } from './services/message';
import { RefreshService } from './services/refresh';
import {
  validateUserIdFormat,
  validateUsernameFormat,
  type ValidationResult,
} from './utils/validation';
import { encodeUserId, decodeUserId } from './utils/userId';
import { GossipSdkEvents } from './types/events';

// Re-export GossipSdkEvents for consumers
export type { GossipSdkEvents } from './types/events';

// ─────────────────────────────────────────────────────────────────────────────
// SDK Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Utility functions exposed through the SDK
 */
export interface SdkUtils {
  /** Validate a user ID format */
  validateUserId: (userId: string) => ValidationResult;
  /** Validate a username format */
  validateUsername: (username: string) => ValidationResult;
  /** Encode a raw user ID to base32 format */
  encodeUserId: (rawId: Uint8Array) => string;
  /** Decode a base32 user ID to raw bytes */
  decodeUserId: (encodedId: string) => Uint8Array;
}

/**
 * The main GossipSdk interface
 *
 * Provides access to all gossip functionality through a unified API.
 */
export interface GossipSdk {
  // ─────────────────────────────────────────────────────────────────
  // Services
  // ─────────────────────────────────────────────────────────────────

  /** Announcement service - handle session announcements */
  readonly announcement: AnnouncementService;

  /** Discussion service - initialize, accept, renew discussions */
  readonly discussion: DiscussionService;

  /** Message service - send, fetch, resend messages */
  readonly message: MessageService;

  /** Refresh service - handle session refresh and keep-alive */
  readonly refresh: RefreshService;

  // ─────────────────────────────────────────────────────────────────
  // User Info
  // ─────────────────────────────────────────────────────────────────

  /** The current user's encoded user ID */
  readonly userId: string;

  /** The underlying session module (for advanced usage) */
  readonly session: SessionModule;

  // ─────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────

  /** Utility functions for validation, encoding, etc. */
  readonly utils: SdkUtils;

  // ─────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────

  /** Event handlers - for advanced usage or updating handlers at runtime */
  readonly events: GossipSdkEvents;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a GossipSdk instance
 *
 * This is the main entry point for using the gossip SDK.
 * Call this after user login when you have a valid session.
 *
 * @deprecated Prefer using the singleton `gossipSdk` for app integrations.
 *
 * @param db - The gossip database instance
 * @param messageProtocol - The message protocol for network communication
 * @param session - The user's session module (from WASM)
 * @param events - Optional event handlers for SDK events
 * @returns A fully configured GossipSdk instance
 *
 * @example
 * ```typescript
 * // After user login
 * const session = new SessionModule(userKeys);
 * const sdk = createGossipSdk(db, messageProtocol, session, {
 *   onMessageReceived: (message) => {
 *     useMessageStore.getState().addMessage(message);
 *   },
 *   onDiscussionRequest: (discussion) => {
 *     useDiscussionStore.getState().addDiscussion(discussion);
 *     showNotification('New chat request!');
 *   },
 *   onError: (error, context) => {
 *     console.error(`[SDK:${context}]`, error);
 *   },
 * });
 *
 * // Now use the SDK
 * await sdk.discussion.initialize(contact, 'Hello!');
 * ```
 */
export function createGossipSdk(
  db: GossipDatabase,
  messageProtocol: IMessageProtocol,
  session: SessionModule,
  events: GossipSdkEvents = {}
): GossipSdk {
  // Create services with proper dependency injection
  // Services will receive the events object to emit events
  const announcementService = new AnnouncementService(
    db,
    messageProtocol,
    session,
    events
  );
  const messageService = new MessageService(
    db,
    messageProtocol,
    session,
    events
  );
  const discussionService = new DiscussionService(
    db,
    announcementService,
    session,
    events
  );
  const refreshService = new RefreshService(
    db,
    messageService,
    session,
    events
  );

  // Create utilities object
  const utils: SdkUtils = {
    validateUserId: validateUserIdFormat,
    validateUsername: validateUsernameFormat,
    encodeUserId,
    decodeUserId,
  };

  return {
    // Services
    announcement: announcementService,
    discussion: discussionService,
    message: messageService,
    refresh: refreshService,

    // User info
    userId: session.userIdEncoded,
    session,

    // Utilities
    utils,

    // Events (exposed for runtime updates if needed)
    events,
  };
}

// Re-export types that consumers might need
export type { GossipDatabase, Message, Discussion, Contact } from './db';
export type { IMessageProtocol } from './api/messageProtocol';
export type { SessionModule } from './wasm/session';
