/**
 * Session Refresh Service
 *
 * Provides helpers to periodically refresh sessions and handle
 * keep-alive messages and broken sessions.
 */

import {
  db,
  Discussion,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { SessionStatus } from '../assets/generated/wasm/gossip_wasm';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { messageService } from './message';
import { Logger } from '../utils/logs';

const logger = new Logger('RefreshService');

/**
 * Handle session refresh for a given user:
 * - Calls the SessionModule.refresh() function to get peers that require keep-alive.
 * - For each discussion of the user:
 *   - If the peer session status is Killed, marks the discussion as BROKEN.
 *   - If the discussion is not BROKEN and its peer requires a keep-alive,
 *     sends a keep-alive message via the session manager.
 *
 * Errors are logged with console.error but do not throw, so callers can safely
 * invoke this periodically (e.g. from background tasks).
 */
export async function handleSessionRefresh(
  ownerUserId: string,
  session: SessionModule,
  ActiveDiscussions: Discussion[]
): Promise<void> {
  const log = logger.forMethod('handleSessionRefresh');
  log.info('calling session refresh', {
    ownerUserId: ownerUserId,
    discussions: ActiveDiscussions.map(discussion => discussion.contactUserId),
  });
  if (!ActiveDiscussions.length) {
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
  for (const discussion of ActiveDiscussions) {
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
        await db.discussions.update(discussion.id!, {
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
      await messageService.sendMessage(
        {
          ownerUserId: discussion.ownerUserId,
          contactUserId: discussion.contactUserId,
          content: '',
          type: MessageType.KEEP_ALIVE,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        },
        session
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
