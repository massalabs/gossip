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
  if (!ActiveDiscussions.length) {
    return;
  }

  if (!ownerUserId) {
    console.error(
      'handleSessionRefresh: ownerUserId is empty, skipping session refresh'
    );
    return;
  }

  let keepAlivePeerIds: string[] = [];
  try {
    // Ask the session manager which peers require keep-alive messages
    keepAlivePeerIds = session.refresh().map(peer => encodeUserId(peer));
  } catch (error) {
    console.error(
      'handleSessionRefresh: error while refreshing session:',
      error
    );
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
        console.log(
          `handleSessionRefresh: session for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} is killed. Marking as broken.`
        );
        // Mark discussion as broken if session is killed
        await db.discussions.update(discussion.id!, {
          status: DiscussionStatus.BROKEN,
          updatedAt: now,
        });
        console.log(
          `handleSessionRefresh: discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} has been marked as broken.`
        );
        continue;
      }
    } catch (error) {
      console.error(
        'handleSessionRefresh: error while processing discussion',
        discussion.id,
        ', error:',
        error
      );
      continue;
    }

    // Check if this peer requires a keep-alive
    const needsKeepAlive = keepAlivePeerIds.some(
      peer => peer === discussion.contactUserId
    );

    if (!needsKeepAlive) {
      continue;
    }

    console.log(
      `handleSessionRefresh: discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} does require a keep-alive message.`
    );

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
      console.log(
        `handleSessionRefresh: keep-alive message sent successfully for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId}`
      );
    } catch (error) {
      console.error(
        'handleSessionRefresh: failed to send keep-alive message for discussion',
        discussion.id,
        ', session status:',
        sessionStatusToString(
          session.peerSessionStatus(decodeUserId(discussion.contactUserId))
        ),
        ', error:',
        error
      );
    }
  }
}
