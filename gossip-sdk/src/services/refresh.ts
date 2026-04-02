/**
 * Session Refresh Service
 *
 * Class-based service to periodically refresh sessions and handle
 * keep-alive messages and broken sessions.
 */

import {
  type Discussion,
  type Queries,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db/index.js';
import { toSortedDiscussions } from '../utils/discussions.js';
import type { SessionModule } from '../wasm/session.js';
import { SessionStatus } from '../wasm/bindings.js';
import { decodeUserId, encodeUserId } from '../utils/userId.js';
import { MessageService } from './message.js';
import { AnnouncementService } from './announcement.js';
import { DiscussionService } from './discussion.js';
import { Logger } from '../utils/logs.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type { SdkConfig } from '../config/sdk.js';
import * as schema from '../db/schema/index.js';
import { SELF_CONTACT_ID } from './selfMessage.js';

const logger = new Logger('RefreshService');

/**
 * Service for refreshing sessions and handling keep-alive messages.
 *
 * @example
 * ```typescript
 * const refreshService = new RefreshService(
 *   messageService,
 *   discussionService,
 *   announcementService,
 *   session,
 *   eventEmitter
 * );
 *
 * // Handle session refresh for active discussions
 * await refreshService.handleSessionRefresh(activeDiscussions);
 * ```
 */
export class RefreshService {
  private messageService: MessageService;
  private announcementService: AnnouncementService;
  private discussionService: DiscussionService;
  private session: SessionModule;
  private isUpdating = false;
  private eventEmitter: SdkEventEmitter;
  private queries: Queries;
  private config: SdkConfig;
  private sessionStatusMap: Map<string, SessionStatus> = new Map();

  constructor(
    messageService: MessageService,
    discussionService: DiscussionService,
    announcementService: AnnouncementService,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    queries: Queries,
    config: SdkConfig
  ) {
    this.messageService = messageService;
    this.discussionService = discussionService;
    this.announcementService = announcementService;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.queries = queries;
    this.config = config;
  }

  /**
   * Emit sessionStatusChanged events for discussions whose session status
   * has changed since the last check.
   */
  async refreshSessionsStatusEvent(): Promise<void> {
    const ownerUserId = this.session.userIdEncoded;
    if (!ownerUserId) {
      return;
    }

    const allRows = await this.queries.discussions.getByOwner(ownerUserId);
    const discussions = toSortedDiscussions(allRows);

    for (const discussion of discussions) {
      if (discussion.contactUserId === SELF_CONTACT_ID) {
        continue;
      }
      const peerId = decodeUserId(discussion.contactUserId);
      const status = this.session.peerSessionStatus(peerId);
      const previous = this.sessionStatusMap.get(discussion.contactUserId);

      if (previous !== status) {
        this.sessionStatusMap.set(discussion.contactUserId, status);
        this.eventEmitter.emit(
          SdkEventType.SESSION_STATUS_CHANGED,
          discussion.contactUserId,
          status
        );
      }
    }
  }

  /**
   * Update state for all discussions:
   * - Cleanup orphaned peers
   * - Refresh sessions and trigger create_session for lost sessions
   * - Send queued announcements
   * - Send queued messages and keep-alives
   *
   * @param discussions - Array of discussions to process
   */
  async stateUpdate(): Promise<void> {
    const log = logger.forMethod('stateUpdate');
    const ownerUserId = this.session.userIdEncoded;

    if (this.isUpdating) {
      log.info('update_state already running, skipping');
      return;
    }

    this.isUpdating = true;
    // Defer session persists: batch all state changes into 1 persist at the end.
    this.session.beginDeferPersist();
    try {
      if (!ownerUserId) {
        log.error('ownerUserId is empty, skipping update_state');
        return;
      }

      const allRows = await this.queries.discussions.getByOwner(ownerUserId);
      const discussions = toSortedDiscussions(allRows);

      if (!discussions.length) {
        return;
      }

      log.info('calling update_state', {
        ownerUserId: ownerUserId,
        discussions: discussions.map(discussion => discussion.contactUserId),
      });

      // Step 0: cleanup orphaned sessions
      const discussionPeerIds = new Set(
        discussions
          .filter(discussion => discussion.contactUserId !== SELF_CONTACT_ID)
          .map(discussion => discussion.contactUserId)
      );
      const sessionPeers = this.session.peerList();
      for (const peerId of sessionPeers) {
        const encoded = encodeUserId(peerId);
        if (!discussionPeerIds.has(encoded)) {
          await this.session.peerDiscard(peerId);
          log.info('discarded orphaned session peer', {
            contactUserId: encoded,
          });
        }
      }

      // Step 1: refresh sessions and create_session for lost sessions
      const refreshResult = await this.session.refresh();
      const keepAlivePeerIds = refreshResult.map(peer => encodeUserId(peer));

      for (const discussion of discussions) {
        if (discussion.contactUserId === SELF_CONTACT_ID) {
          continue;
        }
        const peerId = decodeUserId(discussion.contactUserId);
        const status = this.session.peerSessionStatus(peerId);
        await this.handleSessionStatus(discussion, status);
      }

      // Step 2: send announcements
      const refreshRows =
        await this.queries.discussions.getByOwner(ownerUserId);
      const discussionsAfterRefresh = toSortedDiscussions(refreshRows);
      const activePendingDiscussions = discussionsAfterRefresh.filter(
        discussion => {
          if (discussion.contactUserId === SELF_CONTACT_ID) {
            return false;
          }
          const status = this.session.peerSessionStatus(
            decodeUserId(discussion.contactUserId)
          );
          return [
            SessionStatus.Active,
            SessionStatus.SelfRequested,
            SessionStatus.Saturated,
          ].includes(status);
        }
      );
      await this.announcementService.processOutgoingAnnouncements(
        activePendingDiscussions
      );

      // Step 3: send queued messages and keep-alives
      // NOTE: only flush queued messages once the session is fully Active or saturated.
      // SelfRequested means the handshake is still establishing and
      // session.sendMessage() can return null.
      const activeEstablishedDiscussions = activePendingDiscussions.filter(
        discussion =>
          // saturated sessions can't send messages on session manager but it's still possible to send on network msg that have already been encrypted if any
          [SessionStatus.Active, SessionStatus.Saturated].includes(
            this.session.peerSessionStatus(
              decodeUserId(discussion.contactUserId)
            )
          )
      );
      const keepAliveSet = new Set(keepAlivePeerIds);
      for (const discussion of activeEstablishedDiscussions) {
        if (discussion.contactUserId === SELF_CONTACT_ID) {
          continue;
        }
        if (!discussion.weAccepted) continue;

        // Send keep alive message if needed
        if (
          keepAliveSet.has(discussion.contactUserId) &&
          this.session.peerSessionStatus(
            decodeUserId(discussion.contactUserId)
          ) === SessionStatus.Active
        ) {
          // Send keep alive message only if no messages are pending
          const pendingCount = await this.messageService.getPendingSendCount(
            discussion.contactUserId
          );
          if (pendingCount === 0) {
            const result = await this.messageService.sendMessage({
              contactUserId: discussion.contactUserId,
              ownerUserId,
              content: '',
              type: MessageType.KEEP_ALIVE,
              direction: MessageDirection.OUTGOING,
              status: MessageStatus.WAITING_SESSION,
              timestamp: new Date(),
            });
            if (!result.success) {
              this.eventEmitter.emit(
                SdkEventType.ERROR,
                new Error(result.error || 'Unknown error'),
                'keep_alive_message'
              );
            }
          }
        }

        // process msg in send queue for contact
        const result = await this.messageService.processSendQueueForContact(
          discussion.contactUserId
        );
        if (!result.success) {
          log.error('failed to process send queue for contact', {
            contactUserId: discussion.contactUserId,
            error: result.error,
          });
        }
      }
      // Step 4: hard-delete messages that have exceeded retention duration
      await this.messageService.deleteExpiredMessages(ownerUserId);
    } catch (error) {
      log.error('error in update_state', { error });
    } finally {
      // Flush deferred session persist (1 persist for the entire stateUpdate).
      await this.session.flushPersist();
      this.isUpdating = false;
    }
  }

  private getJitteredDelayMs(baseMs: number, jitterMs: number): number {
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    return Math.max(0, Math.round(baseMs + jitter));
  }

  private async updateSessionRecovery(
    discussion: Discussion,
    updates?: {
      killedNextRetryAt?: Date | null;
      saturatedRetryAt?: Date | null;
      saturatedRetryDone: boolean;
    }
  ): Promise<void> {
    if (!discussion.id) {
      return;
    }

    type DiscussionUpdate = Partial<typeof schema.discussions.$inferInsert>;

    if (!updates) {
      // Clear all recovery fields
      if (
        (discussion.killedNextRetryAt === null ||
          discussion.killedNextRetryAt === undefined) &&
        (discussion.saturatedRetryAt === null ||
          discussion.saturatedRetryAt === undefined) &&
        (discussion.saturatedRetryDone === null ||
          discussion.saturatedRetryDone === undefined)
      ) {
        return; // Already cleared
      }

      const updateData: DiscussionUpdate = {
        killedNextRetryAt: null,
        saturatedRetryAt: null,
        saturatedRetryDone: false,
      };
      await this.queries.discussions.updateById(discussion.id, updateData);
      return;
    }

    const currentNormalized = {
      killedNextRetryAt: discussion.killedNextRetryAt?.getTime() ?? null,
      saturatedRetryAt: discussion.saturatedRetryAt?.getTime() ?? null,
    };
    const nextNormalized = {
      killedNextRetryAt: updates.killedNextRetryAt?.getTime() ?? null,
      saturatedRetryAt: updates.saturatedRetryAt?.getTime() ?? null,
    };
    const isSame =
      currentNormalized.killedNextRetryAt ===
        nextNormalized.killedNextRetryAt &&
      currentNormalized.saturatedRetryAt === nextNormalized.saturatedRetryAt &&
      discussion.saturatedRetryDone === updates.saturatedRetryDone;
    if (isSame) {
      return;
    }

    const updateData: DiscussionUpdate = {
      killedNextRetryAt: updates.killedNextRetryAt,
      saturatedRetryAt: updates.saturatedRetryAt,
      saturatedRetryDone: updates.saturatedRetryDone,
    };
    await this.queries.discussions.updateById(discussion.id, updateData);
  }

  private async handleSessionStatus(
    discussion: Discussion,
    status: SessionStatus
  ): Promise<void> {
    const now = new Date();

    const log = logger.forMethod('handleSessionStatus');

    if (status === SessionStatus.Active) {
      await this.updateSessionRecovery(discussion, undefined);
      return;
    }

    if (
      [SessionStatus.SelfRequested, SessionStatus.PeerRequested].includes(
        status
      )
    ) {
      return;
    }

    if (!discussion.weAccepted) {
      return;
    }

    if (
      status === SessionStatus.NoSession ||
      status === SessionStatus.UnknownPeer
    ) {
      log.error('no session or unknown peer', {
        contactUserId: discussion.contactUserId,
        status: status,
      });
      return;
    }

    if (status === SessionStatus.Killed) {
      const nextRetryAt = discussion.killedNextRetryAt;
      if (nextRetryAt && nextRetryAt.getTime() > now.getTime()) {
        return;
      }
      const res = await this.discussionService.createSessionForContact(
        discussion.contactUserId,
        new Uint8Array(0)
      );
      if (!res.success) {
        log.error('failed to create session for contact', {
          contactUserId: discussion.contactUserId,
          error: res.error,
        });
        return; // if we failed to create session, we don't want to set killedNextRetryAt
      } else {
        this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, discussion);
      }
      const delayMs = this.getJitteredDelayMs(
        this.config.sessionRecovery.killedRetryDelayMs,
        this.config.sessionRecovery.JitterMs
      );
      await this.updateSessionRecovery(discussion, {
        killedNextRetryAt: new Date(now.getTime() + delayMs),
        saturatedRetryDone: false,
      });
      return;
    }

    if (status === SessionStatus.Saturated) {
      const retryAt = discussion.saturatedRetryAt;
      if (
        discussion.saturatedRetryDone ||
        (retryAt && retryAt.getTime() > now.getTime())
      ) {
        return;
      }
      if (!retryAt) {
        const delayMs = this.getJitteredDelayMs(
          this.config.sessionRecovery.saturatedRetryDelayMs,
          this.config.sessionRecovery.JitterMs
        );
        await this.updateSessionRecovery(discussion, {
          saturatedRetryAt: new Date(now.getTime() + delayMs),
          saturatedRetryDone: false,
        });
        return;
      }
      const res = await this.discussionService.createSessionForContact(
        discussion.contactUserId,
        new Uint8Array(0)
      );
      if (!res.success) {
        log.error('failed to create session for contact', {
          contactUserId: discussion.contactUserId,
          error: res.error,
        });
        return; // if we failed to create session, we don't want to set saturatedRetryDone to true
      } else {
        this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, discussion);
      }
      await this.updateSessionRecovery(discussion, {
        saturatedRetryDone: true,
      });
    }
  }
}
