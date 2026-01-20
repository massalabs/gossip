/**
 * Session Refresh Service
 *
 * Class-based service to periodically refresh sessions and handle
 * keep-alive messages and broken sessions.
 */

import {
  type Discussion,
  type GossipDatabase,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { sessionStatusToString } from '../wasm/session';
import type { SessionModule } from '../wasm/session';
import { SessionStatus } from '../assets/generated/wasm/gossip_wasm';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { MessageService } from './message';
import { Logger } from '../utils/logs';
import { GossipSdkEvents } from '../types/events';

const logger = new Logger('RefreshService');

/**
 * Service for refreshing sessions and handling keep-alive messages.
 *
 * @example
 * ```typescript
 * const refreshService = new RefreshService(db, messageService, session);
 *
 * // Handle session refresh for active discussions
 * await refreshService.handleSessionRefresh(activeDiscussions);
 * ```
 */
export class RefreshService {
  private messageService: MessageService;
  private session: SessionModule;
  private events: GossipSdkEvents;

  constructor(
    _db: GossipDatabase,
    messageService: MessageService,
    session: SessionModule,
    events: GossipSdkEvents = {}
  ) {
    // Note: db parameter kept for API compatibility but not currently used
    this.messageService = messageService;
    this.session = session;
    this.events = events;
  }

  /**
   * Handle session refresh for a given user:
   * - Calls the SessionModule.refresh() function to get peers that require keep-alive.
   * - For each discussion of the user:
   *   - If the peer session status is Killed, marks the discussion as BROKEN.
   *   - If the discussion is not BROKEN and its peer requires a keep-alive,
   *     sends a keep-alive message via the session manager.
   *
   * Errors are logged via the Logger instance (log.error) but do not throw, so callers can safely
   * invoke this periodically (e.g. from background tasks).
   *
   * @param activeDiscussions - Array of active discussions
   */
  async handleSessionRefresh(activeDiscussions: Discussion[]): Promise<void> {
    const log = logger.forMethod('handleSessionRefresh');
    const ownerUserId = this.session.userIdEncoded;

    log.info('calling session refresh', {
      ownerUserId: ownerUserId,
      discussions: activeDiscussions.map(
        discussion => discussion.contactUserId
      ),
    });
    if (!activeDiscussions.length) {
      return;
    }

    if (!ownerUserId) {
      log.error('ownerUserId is empty, skipping session refresh');
      return;
    }

    // Log session status BEFORE refresh for debugging
    const statusBefore = activeDiscussions.map(d => {
      try {
        const peerId = decodeUserId(d.contactUserId);
        const status = this.session.peerSessionStatus(peerId);
        return {
          contact: d.contactUserId.slice(0, 12),
          status: sessionStatusToString(status),
        };
      } catch {
        return { contact: d.contactUserId.slice(0, 12), status: 'ERROR' };
      }
    });
    console.log('[SessionStatus] Before refresh():', statusBefore);

    let keepAlivePeerIds: string[] = [];
    try {
      // Ask the session manager which peers require keep-alive messages
      // WARNING: refresh() may KILL sessions based on timeout logic!
      const refreshResult = await this.session.refresh();
      keepAlivePeerIds = refreshResult.map(peer => encodeUserId(peer));
    } catch (error) {
      log.error('error while refreshing session', { error });
      return;
    }

    // Log session status AFTER refresh for debugging
    const statusAfter = activeDiscussions.map(d => {
      try {
        const peerId = decodeUserId(d.contactUserId);
        const status = this.session.peerSessionStatus(peerId);
        return {
          contact: d.contactUserId.slice(0, 12),
          status: sessionStatusToString(status),
        };
      } catch {
        return { contact: d.contactUserId.slice(0, 12), status: 'ERROR' };
      }
    });
    console.log('[SessionStatus] After refresh():', statusAfter);

    /* refresh function kill sessions that have no incoming messages for a long time
    So we need to mark corresponding discussions as broken if it is the case */
    for (const discussion of activeDiscussions) {
      try {
        // Decode contact userId to the peerId format expected by SessionModule
        const peerId = decodeUserId(discussion.contactUserId);

        // Check current session status for this peer
        const status = this.session.peerSessionStatus(peerId);

        // Per spec: when session is Killed/Saturated/UnknownPeer/NoSession,
        // trigger auto-renewal instead of marking as BROKEN
        const needsRenewal = [
          SessionStatus.Killed,
          SessionStatus.Saturated,
          SessionStatus.NoSession,
          SessionStatus.UnknownPeer,
        ].includes(status);

        if (needsRenewal) {
          // Log clearly to console for debugging
          console.warn(
            `[SessionStatus] ${discussion.contactUserId.slice(0, 16)}... -> ${sessionStatusToString(status)} (triggering renewal)`
          );

          log.info('session needs renewal, triggering auto-renewal', {
            ownerUserId: discussion.ownerUserId,
            contactUserId: discussion.contactUserId,
            sessionStatus: sessionStatusToString(status),
          });

          // Trigger auto-renewal (spec: call create_session)
          this.events.onSessionRenewalNeeded?.(discussion.contactUserId);
          continue;
        }

        // PeerRequested for an active discussion is a state inconsistency:
        // - DB says discussion is ACTIVE (we accepted)
        // - Session manager says PeerRequested (we haven't accepted)
        // This should not happen - throw to surface the bug rather than hide it
        if (status === SessionStatus.PeerRequested) {
          const error = new Error(
            `Unexpected PeerRequested status for active discussion with ${discussion.contactUserId}. ` +
              `This indicates a state inconsistency between the database and session manager.`
          );
          log.error('state inconsistency detected', {
            error,
            discussionId: discussion.id,
          });
          throw error;
        }
      } catch (error) {
        log.error('error while processing discussion', {
          error: error,
          discussionId: discussion.id,
        });
        // Re-throw state inconsistency errors - they should surface
        if (
          error instanceof Error &&
          error.message.includes('state inconsistency')
        ) {
          throw error;
        }
        continue;
      }

      // Check if this peer requires a keep-alive
      const needsKeepAlive = keepAlivePeerIds.some(
        peer => peer === discussion.contactUserId
      );

      if (!needsKeepAlive) {
        continue;
      }

      log.info('discussion does require a keep-alive message.', {
        ownerUserId: discussion.ownerUserId,
        contactUserId: discussion.contactUserId,
      });

      try {
        // Send a keep-alive message via the session manager
        await this.messageService.sendMessage({
          ownerUserId: discussion.ownerUserId,
          contactUserId: discussion.contactUserId,
          content: '',
          type: MessageType.KEEP_ALIVE,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        });
        log.info('keep-alive message sent successfully.', {
          ownerUserId: discussion.ownerUserId,
          contactUserId: discussion.contactUserId,
        });
      } catch (error) {
        log.error('failed to send keep-alive message', {
          error: error,
          discussionId: discussion.id,
          sessionStatus: sessionStatusToString(
            this.session.peerSessionStatus(
              decodeUserId(discussion.contactUserId)
            )
          ),
        });
      }
    }
  }
}
