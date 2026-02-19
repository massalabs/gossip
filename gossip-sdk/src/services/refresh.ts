/**
 * Session Refresh Service
 *
 * Class-based service to periodically refresh sessions and handle
 * keep-alive messages and broken sessions.
 */

import {
  type GossipDatabase,
  MessageType,
  MessageDirection,
  MessageStatus,
} from '../db';
import type { SessionModule } from '../wasm/session';
import { SessionStatus } from '../wasm/bindings';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { MessageService } from './message';
import { AnnouncementService } from './announcement';
import { DiscussionService } from './discussion';
import { Logger } from '../utils/logs';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';
import type { Discussion } from '../db';
import type { SdkConfig } from '../config/sdk';

const logger = new Logger('RefreshService');

/**
 * Service for refreshing sessions and handling keep-alive messages.
 *
 * @example
 * ```typescript
 * const refreshService = new RefreshService(
 *   db,
 *   messageService,
 *   discussionService,
 *   announcementService,
 *   session
 * );
 *
 * // Handle session refresh for active discussions
 * await refreshService.handleSessionRefresh(activeDiscussions);
 * ```
 */
export class RefreshService {
  private db: GossipDatabase;
  private messageService: MessageService;
  private announcementService: AnnouncementService;
  private discussionService: DiscussionService;
  private session: SessionModule;
  private isUpdating = false;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;

  constructor(
    db: GossipDatabase,
    messageService: MessageService,
    discussionService: DiscussionService,
    announcementService: AnnouncementService,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig
  ) {
    this.db = db;
    this.messageService = messageService;
    this.discussionService = discussionService;
    this.announcementService = announcementService;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
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
    try {
      if (!ownerUserId) {
        log.error('ownerUserId is empty, skipping update_state');
        return;
      }

      const discussions = await this.db.getDiscussionsByOwner(ownerUserId);

      if (!discussions.length) {
        return;
      }

      log.info('calling update_state', {
        ownerUserId: ownerUserId,
        discussions: discussions.map(discussion => discussion.contactUserId),
      });

      // Step 0: cleanup orphaned sessions
      const discussionPeerIds = new Set(
        discussions.map(discussion => discussion.contactUserId)
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
        const peerId = decodeUserId(discussion.contactUserId);
        const status = this.session.peerSessionStatus(peerId);
        await this.handleSessionStatus(discussion, status);
      }

      // Step 2: send announcements
      const discussionsAfterRefresh =
        await this.db.getDiscussionsByOwner(ownerUserId);
      const activePendingDiscussions = discussionsAfterRefresh.filter(
        discussion => {
          const status = this.session.peerSessionStatus(
            decodeUserId(discussion.contactUserId)
          );
          return [SessionStatus.Active, SessionStatus.SelfRequested].includes(
            status
          );
        }
      );
      await this.announcementService.processOutgoingAnnouncements(
        activePendingDiscussions
      );

      // Step 3: send queued messages and keep-alives
      const keepAliveSet = new Set(keepAlivePeerIds);
      for (const discussion of activePendingDiscussions) {
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
    } catch (error) {
      log.error('error in update_state', { error });
    } finally {
      this.isUpdating = false;
    }
  }

  private getJitteredDelayMs(baseMs: number, jitterMs: number): number {
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    return Math.max(0, Math.round(baseMs + jitter));
  }

  private async updateSessionRecovery(
    discussion: Discussion,
    nextRecovery?: Discussion['sessionRecovery']
  ): Promise<void> {
    const current = discussion.sessionRecovery;
    const normalize = (recovery?: Discussion['sessionRecovery']) => ({
      killedNextRetryAt: recovery?.killedNextRetryAt?.getTime() ?? null,
      saturatedRetryAt: recovery?.saturatedRetryAt?.getTime() ?? null,
      saturatedRetryDone: recovery?.saturatedRetryDone ?? null,
    });
    const currentNormalized = normalize(current);
    const nextNormalized = normalize(nextRecovery);
    const isSame =
      currentNormalized.killedNextRetryAt ===
        nextNormalized.killedNextRetryAt &&
      currentNormalized.saturatedRetryAt === nextNormalized.saturatedRetryAt &&
      currentNormalized.saturatedRetryDone ===
        nextNormalized.saturatedRetryDone;
    if (isSame) {
      return;
    }
    if (!discussion.id) {
      return;
    }
    await this.db.discussions.update(discussion.id, {
      sessionRecovery: nextRecovery,
    });
  }

  private async handleSessionStatus(
    discussion: Discussion,
    status: SessionStatus
  ): Promise<void> {
    const now = new Date();

    const log = logger.forMethod('handleSessionStatus');
    const recovery = discussion.sessionRecovery ?? {};

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
      const nextRetryAt = recovery.killedNextRetryAt;
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
      } else {
        this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, discussion);
      }
      const delayMs = this.getJitteredDelayMs(
        this.config.sessionRecovery.killedRetryDelayMs,
        this.config.sessionRecovery.JitterMs
      );
      await this.updateSessionRecovery(discussion, {
        ...recovery,
        killedNextRetryAt: new Date(now.getTime() + delayMs),
      });
      return;
    }

    if (status === SessionStatus.Saturated) {
      const retryAt = recovery.saturatedRetryAt;
      if (
        recovery.saturatedRetryDone ||
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
          ...recovery,
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
      } else {
        this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, discussion);
      }
      await this.updateSessionRecovery(discussion, {
        ...recovery,
        saturatedRetryDone: true,
      });
    }
  }
}
