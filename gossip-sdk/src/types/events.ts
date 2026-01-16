/**
 * SDK Event Types
 *
 * Event handlers for SDK events. These are used by the SDK to notify
 * the host application about state changes.
 */

import { Message, Discussion, Contact } from '../db';

/**
 * Event handlers for SDK events.
 *
 * The SDK emits events when things happen (messages received, discussions created, etc.)
 * Your app can listen to these events and update its own state (zustand, redux, etc.)
 *
 * This pattern keeps the SDK decoupled from any specific state management solution.
 */
export interface GossipSdkEvents {
  // ─────────────────────────────────────────────────────────────────
  // Message Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Called when a new message is received from a contact.
   * Use this to update your message list UI.
   */
  onMessageReceived?: (message: Message) => void;

  /**
   * Called when a message is successfully sent.
   * Use this to update message status in UI (sending → sent).
   */
  onMessageSent?: (message: Message) => void;

  /**
   * Called when sending a message fails.
   * Use this to show error state and allow retry.
   */
  onMessageFailed?: (message: Message, error: Error) => void;

  // ─────────────────────────────────────────────────────────────────
  // Discussion Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Called when someone sends you a discussion request (announcement).
   * Use this to show the request in your discussion list.
   */
  onDiscussionRequest?: (discussion: Discussion, contact: Contact) => void;

  /**
   * Called when a discussion status changes (accepted, broken, etc.).
   * Use this to update discussion state in UI.
   */
  onDiscussionStatusChanged?: (discussion: Discussion) => void;

  // ─────────────────────────────────────────────────────────────────
  // Session Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Called when a session with a contact is broken and needs renewal.
   * Use this to show appropriate UI state.
   * @deprecated Use onSessionRenewalNeeded for auto-renewal flow
   */
  onSessionBroken?: (contactUserId: string) => void;

  /**
   * Called when a session is successfully renewed.
   */
  onSessionRenewed?: (discussion: Discussion) => void;

  /**
   * Called when a session needs to be renewed (auto-renewal).
   * The SDK will automatically attempt to renew the session.
   * Messages are queued with WAITING_SESSION status until session is active.
   */
  onSessionRenewalNeeded?: (contactUserId: string) => void;

  // ─────────────────────────────────────────────────────────────────
  // Error Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Called when an error occurs in any SDK operation.
   * Use this for logging, error reporting, or showing error toasts.
   *
   * @param error - The error that occurred
   * @param context - Where the error occurred (e.g., 'message.send', 'announcement.fetch')
   */
  onError?: (error: Error, context: string) => void;
}
