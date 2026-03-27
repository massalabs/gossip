/**
 * Session Refresh Service
 *
 */

import { type Session, type Queries, MessageType, MessageDirection, MessageStatus } from '../../db/index.js';
import type { SessionModule } from '../../wasm/session.js';
import { SessionStatus } from '../../wasm/bindings.js';
import { decodeUserId, encodeUserId } from '../../utils/userId.js';
import { Logger } from '../../utils/logs.js';
import { SdkEventEmitter, SdkEventType } from '../../core/SdkEventEmitter.js';
import type { SdkConfig } from '../../config/sdk.js';
import * as schema from '../../db/schema/index.js';
import { SessionAnnouncementService } from './sessionAnnouncement.js';
import { SessionMessageService } from './sessionMessage.js';
import { Result } from '../../utils/type.js';

const logger = new Logger('SessionRefreshService');


export class SessionRefreshService {
  private sessionMessageService: SessionMessageService;
  private sessionAnnouncementService: SessionAnnouncementService;
  private session: SessionModule;
  private isUpdating = false;
  private eventEmitter: SdkEventEmitter;
  private resetSession: (contactUserId: string) => Promise<Result<Uint8Array, Error>>;
  private queries: Queries;
  private config: SdkConfig;
  private sessionStatusMap: Map<string, SessionStatus> = new Map();

  constructor(
    resetSession: (contactUserId: string) => Promise<Result<Uint8Array, Error>>,
    session: SessionModule,
    sessionMessageService: SessionMessageService,
    sessionAnnouncementService: SessionAnnouncementService,
    eventEmitter: SdkEventEmitter,
    queries: Queries,
    config: SdkConfig
  ) {
    this.resetSession = resetSession;
    this.session = session;
    this.sessionMessageService = sessionMessageService;
    this.sessionAnnouncementService = sessionAnnouncementService;
    this.eventEmitter = eventEmitter;
    this.queries = queries;
    this.config = config;
  }

  /**
   * Emit sessionStatusChanged events for sessions whose status has changed
   * since the last check.
   */
  async refreshSessionsStatusEvent(): Promise<void> {
    const sessions = await this.queries.sessions.getAll();

    for (const sessionRow of sessions) {
      const peerId = decodeUserId(sessionRow.contactUserId);
      const status = this.session.peerSessionStatus(peerId);
      const previous = this.sessionStatusMap.get(sessionRow.contactUserId);

      if (previous !== status) {
        this.sessionStatusMap.set(sessionRow.contactUserId, status);
        this.eventEmitter.emit(
          SdkEventType.SESSION_STATUS_CHANGED,
          sessionRow.contactUserId,
          status
        );
      }
    }
  }

  /**
   * Update state for all sessions:
   * - Cleanup orphaned peers
   * - Refresh session manager
   * - Trigger retries for killed/saturated sessions
   */
  async stateUpdate(): Promise<void> {
    const log = logger.forMethod('stateUpdate');

    if (this.isUpdating) {
      log.info('update_state already running, skipping');
      return;
    }

    this.isUpdating = true;
    try {
      const sessions = await this.queries.sessions.getAll();

      if (!sessions.length) {
        return;
      }

      log.info('calling update_state', {
        sessions: sessions.map(sessionRow => sessionRow.contactUserId),
      });

      // Step 0: cleanup orphaned sessions from session manager.
      const sessionPeerIds = new Set(
        sessions.map(sessionRow => sessionRow.contactUserId)
      );
      const peers = this.session.peerList();
      for (const peerId of peers) {
        const encoded = encodeUserId(peerId);
        if (!sessionPeerIds.has(encoded)) {
          await this.session.peerDiscard(peerId);
          log.info('discarded orphaned session peer', {
            contactUserId: encoded,
          });
        }
      }

      // Step 1: refresh session manager state and capture keep-alive candidates.
      const refreshResult = await this.session.refresh();
      const keepAlivePeerIds = refreshResult.map(peer => encodeUserId(peer));
      log.debug('session refresh completed', {
        keepAlivePeers: keepAlivePeerIds.length,
      });

      for (const session of sessions) {
        const peerId = decodeUserId(session.contactUserId);
        const status = this.session.peerSessionStatus(peerId);
        await this.handleSessionStatus(session, status);
      }

      // Step 2: send announcements
      const sessionsAfterRefresh =
        await this.queries.sessions.getAll();
      const livePendingSessions = sessionsAfterRefresh.filter(
        session => {
          return [
            SessionStatus.Active,
            SessionStatus.SelfRequested,
            SessionStatus.Saturated,
          ].includes(this.session.peerSessionStatus(decodeUserId(session.contactUserId)));
        }
      );

      await this.sessionAnnouncementService.processOutgoingAnnouncements(
        livePendingSessions
      );

      // Step 3: send queued messages and keep-alives
      // NOTE: only flush queued messages once the session is fully Active or saturated.
      // SelfRequested means the handshake is still establishing and
      // session.sendMessage() can return null.
      const liveEstablishedSessions = livePendingSessions.filter(
        session =>
          // saturated sessions can't send messages on session manager but it's still possible to send on network msg that have already been encrypted if any
          [SessionStatus.Active, SessionStatus.Saturated].includes(
            this.session.peerSessionStatus(
              decodeUserId(session.contactUserId)
            )
          )
      );
      const keepAliveSet = new Set(keepAlivePeerIds);
      for (const session of liveEstablishedSessions) {
        // Send keep alive message if needed
        if (
          keepAliveSet.has(session.contactUserId) &&
          this.session.peerSessionStatus(
            decodeUserId(session.contactUserId)
          ) === SessionStatus.Active
        ) {
          // Send keep alive message only if no messages are pending
          const pendingCount = await this.sessionMessageService.getPendingSendCount(
            session.contactUserId
          );
          if (pendingCount === 0) {
            const result = await this.sessionMessageService.sendMessage({
              contactUserId: session.contactUserId,
              ownerUserId: this.session.userIdEncoded,
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
        const result = await this.sessionMessageService.processSendQueueForContact(
          session.contactUserId
        );
        if (!result.success) {
          log.error('failed to process send queue for contact', {
            contactUserId: session.contactUserId,
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
    sessionRow: Session,
    updates?: {
      killedNextRetryAt?: Date | null;
      saturatedRetryAt?: Date | null;
      saturatedRetryDone: boolean;
    }
  ): Promise<void> {
    if (!sessionRow.id) {
      return;
    }

    type SessionUpdate = Partial<typeof schema.sessions.$inferInsert>;

    if (!updates) {
      if (
        (sessionRow.killedNextRetryAt === null ||
          sessionRow.killedNextRetryAt === undefined) &&
        (sessionRow.saturatedRetryAt === null ||
          sessionRow.saturatedRetryAt === undefined) &&
        (sessionRow.saturatedRetryDone === null ||
          sessionRow.saturatedRetryDone === undefined)
      ) {
        return;
      }

      const updateData: SessionUpdate = {
        killedNextRetryAt: null,
        saturatedRetryAt: null,
        saturatedRetryDone: false,
      };
      await this.queries.sessions.updateById(sessionRow.id, updateData);
      return;
    }

    const currentNormalized = {
      killedNextRetryAt: sessionRow.killedNextRetryAt?.getTime() ?? null,
      saturatedRetryAt: sessionRow.saturatedRetryAt?.getTime() ?? null,
    };
    const nextNormalized = {
      killedNextRetryAt: updates.killedNextRetryAt?.getTime() ?? null,
      saturatedRetryAt: updates.saturatedRetryAt?.getTime() ?? null,
    };
    const isSame =
      currentNormalized.killedNextRetryAt ===
        nextNormalized.killedNextRetryAt &&
      currentNormalized.saturatedRetryAt === nextNormalized.saturatedRetryAt &&
      sessionRow.saturatedRetryDone === updates.saturatedRetryDone;
    if (isSame) {
      return;
    }

    const updateData: SessionUpdate = {
      killedNextRetryAt: updates.killedNextRetryAt,
      saturatedRetryAt: updates.saturatedRetryAt,
      saturatedRetryDone: updates.saturatedRetryDone,
    };
    await this.queries.sessions.updateById(sessionRow.id, updateData);
  }

  private async handleSessionStatus(
    sessionRow: Session,
    status: SessionStatus
  ): Promise<void> {
    const now = new Date();
    const log = logger.forMethod('handleSessionStatus');

    if (status === SessionStatus.Active) {
      await this.updateSessionRecovery(sessionRow, undefined);
      return;
    }

    if (
      [SessionStatus.SelfRequested, SessionStatus.PeerRequested].includes(status)
    ) {
      return;
    }

    if (
      status === SessionStatus.NoSession ||
      status === SessionStatus.UnknownPeer
    ) {
      log.error('no session or unknown peer', {
        contactUserId: sessionRow.contactUserId,
        status,
      });
      return;
    }

    if (status === SessionStatus.Killed) {
      const nextRetryAt = sessionRow.killedNextRetryAt;
      if (nextRetryAt && nextRetryAt.getTime() > now.getTime()) {
        return;
      }

      const res = await this.resetSession(
        sessionRow.contactUserId,
      );
      if (!res.success) {
        log.error('failed to create session for contact', {
          contactUserId: sessionRow.contactUserId,
          error: res.error,
        });
        return;
      }

      const delayMs = this.getJitteredDelayMs(
        this.config.sessionRecovery.killedRetryDelayMs,
        this.config.sessionRecovery.JitterMs
      );
      await this.updateSessionRecovery(sessionRow, {
        killedNextRetryAt: new Date(now.getTime() + delayMs),
        saturatedRetryDone: false,
      });
      return;
    }

    if (status === SessionStatus.Saturated) {
      const retryAt = sessionRow.saturatedRetryAt;
      if (
        sessionRow.saturatedRetryDone ||
        (retryAt && retryAt.getTime() > now.getTime())
      ) {
        return;
      }

      if (!retryAt) {
        const delayMs = this.getJitteredDelayMs(
          this.config.sessionRecovery.saturatedRetryDelayMs,
          this.config.sessionRecovery.JitterMs
        );
        await this.updateSessionRecovery(sessionRow, {
          saturatedRetryAt: new Date(now.getTime() + delayMs),
          saturatedRetryDone: false,
        });
        return;
      }

      const res = await this.resetSession(
        sessionRow.contactUserId,
      );
      if (!res.success) {
        log.error('failed to create session for contact', {
          contactUserId: sessionRow.contactUserId,
          error: res.error,
        });
        return;
      }

      await this.updateSessionRecovery(sessionRow, {
        saturatedRetryDone: true,
      });
    }
  }
}
