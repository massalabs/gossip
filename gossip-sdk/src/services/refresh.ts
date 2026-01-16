/**
 * Session Refresh Service
 *
 * Class-based service to periodically refresh sessions and handle
 * keep-alive messages and broken sessions.
 */

import {
  type Discussion,
  type GossipDatabase,
  DiscussionStatus,
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

const logger = new Logger('RefreshService');

/**
 * Service for refreshing sessions and handling keep-alive messages.
 *
 * @example
 * ```typescript
 * const refreshService = new RefreshService(db, messageService);
 *
 * // Handle session refresh for active discussions
 * await refreshService.handleSessionRefresh(ownerUserId, session, activeDiscussions);
 * ```
 */
export class RefreshService {
  private db: GossipDatabase;
  private messageService: MessageService;

  constructor(db: GossipDatabase, messageService: MessageService) {
    this.db = db;
    this.messageService = messageService;
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
   * @param ownerUserId - The owner user ID
   * @param session - The SessionModule instance
   * @param activeDiscussions - Array of active discussions
   */
  async handleSessionRefresh(
    ownerUserId: string,
    session: SessionModule,
    activeDiscussions: Discussion[]
  ): Promise<void> {
    const log = logger.forMethod('handleSessionRefresh');
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

    let keepAlivePeerIds: string[] = [];
    try {
      // Ask the session manager which peers require keep-alive messages
      keepAlivePeerIds = session.refresh().map(peer => encodeUserId(peer));
    } catch (error) {
      log.error('error while refreshing session', { error });
      return;
    }

    const now = new Date();

    /* refresh function kill sessions that have no incoming messages for a long time
    So we need to mark corresponding discussions as broken if it is the case */
    for (const discussion of activeDiscussions) {
      try {
        // Decode contact userId to the peerId format expected by SessionModule
        const peerId = decodeUserId(discussion.contactUserId);

        // Check current session status for this peer
        const status = session.peerSessionStatus(peerId);

        if (status === SessionStatus.Killed) {
          log.info('session for discussion is killed. Marking as broken.', {
            ownerUserId: discussion.ownerUserId,
            contactUserId: discussion.contactUserId,
          });
          // Mark discussion as broken if session is killed
          await this.db.discussions.update(discussion.id!, {
            status: DiscussionStatus.BROKEN,
            updatedAt: now,
          });
          log.info('discussion has been marked as broken.', {
            ownerUserId: discussion.ownerUserId,
            contactUserId: discussion.contactUserId,
          });
          continue;
        }
      } catch (error) {
        log.error('error while processing discussion', {
          error: error,
          discussionId: discussion.id,
        });
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
        await this.messageService.sendMessage(
          {
            ownerUserId: discussion.ownerUserId,
            contactUserId: discussion.contactUserId,
            content: '',
            type: MessageType.KEEP_ALIVE,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.SENDING,
            timestamp: new Date(),
          },
          session as never
        );
        log.info('keep-alive message sent successfully.', {
          ownerUserId: discussion.ownerUserId,
          contactUserId: discussion.contactUserId,
        });
      } catch (error) {
        log.error('failed to send keep-alive message', {
          error: error,
          discussionId: discussion.id,
          sessionStatus: sessionStatusToString(
            session.peerSessionStatus(decodeUserId(discussion.contactUserId))
          ),
        });
      }
    }
  }
}
