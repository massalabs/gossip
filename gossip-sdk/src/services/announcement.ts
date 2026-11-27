/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import {
  type Discussion,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
  serializeSendAnnouncement,
} from '../db/index.js';
import { toDiscussion } from '../utils/discussions.js';
import { decodeUserId, encodeUserId } from '../utils/userId.js';
import {
  IMessageProtocol,
  type EncryptedMessage,
} from '../api/messageProtocol/index.js';
import { UserPublicKeys, SessionStatus } from '../wasm/bindings.js';
import { SessionModule, sessionStatusToString } from '../wasm/session.js';
import { Logger } from '../utils/logs.js';
import { BulletinItem } from '../api/messageProtocol/types.js';
import { SdkConfig, defaultSdkConfig } from '../config/sdk.js';
import { decodeAnnouncementPayload } from '../utils/announcementPayload.js';
import {
  TEMPORARY_CONTACT_NAME_PREFIX,
  isTemporaryContactName,
} from '../utils/contacts.js';
import { Result } from '../utils/type.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import type { RefreshService } from './refresh.js';
import { Queries } from '../db/queries/index.js';
import { dlog } from '../utils/debugLog.js';
import { errFields, shortId, since } from '../utils/debugFields.js';

/** How many links of a peer's chain of addressed announcements one fetch follows. */
const MAX_ADDRESSED_ROUNDS = 5;

/** An announcement ready to post, and the entry addressing it to the peer if any. */
export type EstablishedAnnouncement = Awaited<
  ReturnType<SessionModule['establishOutgoingSessionAddressed']>
>;

const logger = new Logger('AnnouncementService');

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
}

export const EstablishSessionError =
  'Session manager failed to establish outgoing session';

/**
 * How long after answering a peer's new announcement this device waits
 * before answering another from the same peer. One that comes meanwhile is
 * answered once this time has passed, for the peer's latest announcement.
 */
export const CONNECTION_RENEWAL_ANSWER_MS = 10 * 60 * 1000;

export class AnnouncementService {
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private isProcessingAnnouncements = false;
  /**
   * Peers whose new announcement this device is answering now: the
   * announcement made for it is an answer, not one that waits for an
   * answer. Whether a peer's announcement answers ours, when one was last
   * answered and whether one is owed an answer are kept with the
   * discussion, so that they survive a reload.
   */
  private answering = new Set<string>();
  /** The clock of the renewal answers (tests replace it). */
  private now: () => number = () => Date.now();
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private refreshService?: RefreshService;
  private queries: Queries;

  constructor(
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig,
    queries: Queries
  ) {
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
    this.queries = queries;
  }

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
  }

  setMessageProtocol(messageProtocol: IMessageProtocol): void {
    this.messageProtocol = messageProtocol;
  }

  /**
   * Force-fire the SDK's pending session-blob persist. Wired by
   * `GossipSdk.openSession` via `setPersistFlusher`. Used by the
   * incoming-announcement path to commit the mutated Rust session
   * state to disk BEFORE we commit the SQL row that depends on it
   * — without this, a crash between the SQL inserts and the next
   * debounced flush leaves an orphan Discussion in SQLite whose peer
   * is missing from the session manager, surfacing as
   * `peerSessionStatus = UnknownPeer/NoSession` that survives reboot
   * (and the "TOUTES" badge counts a discussion that never appears
   * in the list).
   *
   * No-op until the SDK calls the setter, so unit tests that
   * instantiate AnnouncementService in isolation keep working.
   */
  private persistFlusher: () => Promise<void> = async () => {};

  setPersistFlusher(flusher: () => Promise<void>): void {
    this.persistFlusher = flusher;
  }

  /**
   * Connections (§5.12): a session asked by a member of a group this device
   * accepted is accepted automatically and silently (`isCoMember`, `accept`);
   * `processed` is told of every announcement read from a peer.
   */
  private connections?: {
    isCoMember: (contactUserId: string) => Promise<boolean>;
    accept: (contactUserId: string) => Promise<void>;
    processed: (contactUserId: string) => Promise<void>;
  };

  setConnectionPolicy(policy: AnnouncementService['connections']): void {
    this.connections = policy;
  }

  /**
   * Posts an announcement to the board and, when one is given and the mesh is
   * on, the entry addressing it to the peer, on the mesh only: an internet
   * node never sees it. Only the board post decides success: a peer running
   * an older version never looks at the addressed entry. With `internetOnly`
   * the board copy goes to the servers alone. The counter is '' when only a
   * mesh took it.
   */
  async sendAnnouncement(
    announcement: Uint8Array,
    mailbox?: { seeker: Uint8Array; data: Uint8Array },
    internetOnly = false
  ): Promise<{
    success: boolean;
    counter?: string;
    error?: string;
  }> {
    const log = logger.forMethod('sendAnnouncement');

    if (mailbox && !internetOnly && this.messageProtocol.isMeshEnabled?.()) {
      try {
        await this.messageProtocol.sendMessage(
          { seeker: mailbox.seeker, ciphertext: mailbox.data },
          { meshOnly: true }
        );
      } catch (error) {
        log.warn('addressed copy not sent', error);
        dlog(
          'sessions',
          'announcement.mailbox.failed',
          { seeker: shortId(mailbox.seeker), ...errFields(error) },
          { lvl: 'warn' }
        );
      }
    }

    const started = performance.now();
    try {
      const counter = await this.messageProtocol.sendAnnouncement(
        announcement,
        internetOnly ? { internetOnly: true } : undefined
      );
      log.info('broadcast successful', { counter });
      dlog(
        'sessions',
        'announcement.posted',
        {
          size: announcement.length,
          counter,
          mailbox: mailbox !== undefined,
          internetOnly,
        },
        { lvl: 'info', dur: since(started) }
      );
      return { success: true, counter };
    } catch (error) {
      log.error('broadcast failed', error);
      dlog(
        'sessions',
        'announcement.post.failed',
        { size: announcement.length, internetOnly, ...errFields(error) },
        { lvl: 'error', dur: since(started) }
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async establishSession(
    contactPublicKeys: UserPublicKeys,
    payloadBytes?: Uint8Array
  ): Promise<Result<EstablishedAnnouncement, Error>> {
    const log = logger.forMethod('establishSession');

    const contactUserId = encodeUserId(contactPublicKeys.derive_id());
    // An announcement that accepts the peer's request, or answers its new
    // announcement, is an answer; any other waits for the peer's.
    const isAnswer =
      this.answering.has(contactUserId) ||
      this.session.peerSessionStatus(contactPublicKeys.derive_id()) ===
        SessionStatus.PeerRequested;

    // CRITICAL: await to ensure session state is persisted before returning
    // the addressed entry only exists for the mesh; without one, the board
    // copy alone travels, as before
    let established: EstablishedAnnouncement;
    try {
      established = this.messageProtocol.isMeshEnabled?.()
        ? await this.session.establishOutgoingSessionAddressed(
            contactPublicKeys,
            payloadBytes
          )
        : {
            announcement: await this.session.establishOutgoingSession(
              contactPublicKeys,
              payloadBytes
            ),
          };
    } catch (error) {
      log.error('empty announcement returned', { contactUserId, error });
      dlog(
        'sessions',
        'announcement.establish.failed',
        { peer: shortId(contactUserId), isAnswer, ...errFields(error) },
        { lvl: 'error' }
      );
      return {
        success: false,
        error: new Error(EstablishSessionError),
      };
    }

    // Whatever it is, it pairs with the peer's latest announcement: no
    // earlier one of the peer is owed an answer any more.
    await this.queries.discussions.updateByOwnerAndContact(
      this.session.userIdEncoded,
      contactUserId,
      { awaitingAnswer: !isAnswer, renewalAnswerOwed: false }
    );

    log.info('announcement prepared for outgoing session', {
      contactUserId,
      bytes: established.announcement.length,
      addressed: established.mailbox !== undefined,
    });
    return { success: true, data: established };
  }

  async processOutgoingAnnouncements(discussions: Discussion[]): Promise<void> {
    const log = logger.forMethod('processOutgoingAnnouncements');
    const now = Date.now();

    for (const discussion of discussions) {
      if (!discussion.id) continue;

      // sendAnnouncement is deserialized by toDiscussion() before reaching here
      if (discussion.sendAnnouncement === null) continue;

      const { announcement_bytes, when_to_send } = discussion.sendAnnouncement;
      if (announcement_bytes.length === 0) {
        log.warn('skipping empty announcement bytes', {
          discussionId: discussion.id,
          contactUserId: discussion.contactUserId,
        });
        await this.queries.discussions.updateById(discussion.id, {
          sendAnnouncement: null,
          updatedAt: new Date(),
        });
        continue;
      }

      if (when_to_send.getTime() > now) {
        log.debug('skipping announcement, not yet time to send', {
          discussionId: discussion.id,
          contactUserId: discussion.contactUserId,
          when_to_send: when_to_send.toISOString(),
          now: new Date().toISOString(),
        });
        continue;
      }

      // Send the announcement and handle updates after transaction
      const { mailbox, internetOnly } = discussion.sendAnnouncement;
      const result = await this.sendAnnouncement(
        announcement_bytes,
        mailbox,
        internetOnly
      );

      // update discussion state after sending
      const latest = await this.queries.discussions.getById(discussion.id);
      if (!latest || latest.sendAnnouncement === null) {
        continue;
      }
      if (result.success && !internetOnly && result.counter === '') {
        // only a mesh took it, which uploads nothing unless it bridges: it
        // goes to a server as soon as one answers
        await this.queries.discussions.updateById(discussion.id, {
          sendAnnouncement: serializeSendAnnouncement({
            announcement_bytes,
            when_to_send: new Date(),
            internetOnly: true,
          }),
          updatedAt: new Date(),
        });
      } else if (result.success) {
        await this.queries.discussions.updateById(discussion.id, {
          sendAnnouncement: null,
          updatedAt: new Date(),
        });
      } else if (internetOnly) {
        // the mesh has it already: only the server copy waits
        await this.queries.discussions.updateById(discussion.id, {
          sendAnnouncement: serializeSendAnnouncement({
            announcement_bytes,
            when_to_send: new Date(
              Date.now() + this.config.announcements.retryDelayMs
            ),
            internetOnly: true,
          }),
          updatedAt: new Date(),
        });
      } else {
        await this.queries.discussions.updateById(discussion.id, {
          sendAnnouncement: serializeSendAnnouncement({
            announcement_bytes,
            mailbox,
            when_to_send: new Date(
              Date.now() + this.config.announcements.retryDelayMs
            ),
          }),
          updatedAt: new Date(),
          /* If send announcement failed, There are chances that the session will be killed again the next state_update call.
          We don't want to wait a delay before reseting the session so we set killedNextRetryAt to null*/
          killedNextRetryAt: null,
        });
      }
    }
  }

  /**
   * Accepts announcements a transport pushed instead of being polled for (a
   * mesh node). They are queued like pending announcements, carry no bulletin
   * counter, and are processed before the next fetch from the node.
   */
  async ingestAnnouncements(
    announcements: Uint8Array[]
  ): Promise<AnnouncementReceptionResult> {
    await this.queries.pendingAnnouncements.insertNew(announcements);
    return this.fetchAndProcessAnnouncements();
  }

  async fetchAndProcessAnnouncements(): Promise<AnnouncementReceptionResult> {
    const log = logger.forMethod('fetchAndProcessAnnouncements');

    if (this.isProcessingAnnouncements) {
      log.info('fetch already in progress, skipping');
      return { success: true, newAnnouncementsCount: 0 };
    }

    const errors: string[] = [];
    let announcements: Uint8Array[] = [];
    let fetchedCounters: string[] = [];
    const cycleStarted = performance.now();

    this.isProcessingAnnouncements = true;
    try {
      const addressedCount = await this._fetchAddressedAnnouncements();
      const pending = await this.queries.pendingAnnouncements.getAll();
      const successfullyProcessedPendingIds: number[] = [];

      if (pending.length > 0) {
        log.info(
          `processing ${pending.length} pending announcements from SQLite`
        );

        // Process pending announcements one by one, tracking successes
        let newAnnouncementsCount = 0;
        for (const item of pending) {
          try {
            const result = await this._processIncomingAnnouncement(
              item.announcement
            );

            // Mark as successfully processed (even if announcement was for unknown peer)
            // Only keep if processing threw an error
            if (item.id !== undefined) {
              successfullyProcessedPendingIds.push(item.id);
            }

            if (result.success && result.contactUserId) {
              newAnnouncementsCount++;
              log.info(
                `processed pending announcement #${newAnnouncementsCount}`,
                {
                  contactUserId: result.contactUserId,
                }
              );
            }
            if (item.counter) fetchedCounters.push(item.counter);
            if (result.error) errors.push(result.error);
          } catch (error) {
            // Don't mark as processed - will be retried next time
            log.error('failed to process pending announcement, will retry', {
              id: item.id,
              error,
            });
            errors.push(
              error instanceof Error ? error.message : 'Unknown error'
            );
          }
        }

        // Delete only successfully processed pending announcements
        if (successfullyProcessedPendingIds.length > 0) {
          await this.queries.pendingAnnouncements.deleteByIds(
            successfullyProcessedPendingIds
          );
          log.info(
            `deleted ${successfullyProcessedPendingIds.length} processed pending announcements`
          );
        }

        if (fetchedCounters.length > 0) {
          const highestCounter = fetchedCounters.reduce((a, b) =>
            Number(a) > Number(b) ? a : b
          );
          await this._upsertLastBulletinCounter(highestCounter);
          log.info('updated lastBulletinCounter', { highestCounter });
        }

        await this._answerOwedRenewals();
        dlog(
          'sessions',
          'announcement.cycle',
          {
            source: 'pending',
            pending: pending.length,
            processed: successfullyProcessedPendingIds.length,
            new: newAnnouncementsCount,
            addressed: addressedCount,
            errors: errors.length,
            ...(errors.length > 0 && { msg: errors.join(', ') }),
          },
          {
            lvl: errors.length > 0 ? 'warn' : 'debug',
            dur: since(cycleStarted),
          }
        );
        return {
          success: errors.length === 0 || newAnnouncementsCount > 0,
          newAnnouncementsCount: newAnnouncementsCount + addressedCount,
          error: errors.length > 0 ? errors.join(', ') : undefined,
        };
      }

      // No pending - fetch from API
      const cursor = await this.queries.announcementCursors.get(
        this.session.userIdEncoded
      );

      // fetch from node all announcements since the last retrieved announcement
      const fetched = await this._fetchAnnouncements(cursor);
      announcements = fetched.map(a => a.data);
      // announcements relayed by another transport carry no counter
      fetchedCounters = fetched.flatMap(a =>
        a.counter !== undefined ? [a.counter] : []
      );

      let newAnnouncementsCount = 0;

      for (const announcement of announcements) {
        try {
          const result = await this._processIncomingAnnouncement(announcement);

          if (result.success && result.contactUserId) {
            newAnnouncementsCount++;
            log.info(`processed new announcement #${newAnnouncementsCount}`, {
              contactUserId: result.contactUserId,
            });
          }

          if (result.error) errors.push(result.error);
        } catch (error) {
          // Not kept for a retry: the cursor moves past it below.
          dlog(
            'sessions',
            'announcement.process.failed',
            { size: announcement.length, retried: false, ...errFields(error) },
            { lvl: 'error' }
          );
          errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
      }

      if (fetchedCounters.length > 0) {
        const highestCounter = fetchedCounters.reduce((a, b) =>
          Number(a) > Number(b) ? a : b
        );
        const cursorNum = cursor !== undefined ? Number(cursor) : 0;
        const highestNum = Number(highestCounter);
        // If API returned a batch with max <= cursor (same or older page), advance past it
        // so we don't re-fetch the same page forever (e.g. API returning "latest" regardless of after)
        const nextCounter =
          highestNum <= cursorNum ? String(cursorNum + 1) : highestCounter;
        await this._upsertLastBulletinCounter(nextCounter);
        log.info('updated lastBulletinCounter', {
          lastBulletinCounter: nextCounter,
        });
      }
      await this._persistTransportCursors();
      await this._answerOwedRenewals();
      dlog(
        'sessions',
        'announcement.cycle',
        {
          source: 'fetch',
          cursor: cursor ?? null,
          fetched: announcements.length,
          new: newAnnouncementsCount,
          addressed: addressedCount,
          errors: errors.length,
          ...(errors.length > 0 && { msg: errors.join(', ') }),
        },
        {
          lvl: errors.length > 0 ? 'warn' : 'debug',
          dur: since(cycleStarted),
        }
      );

      return {
        success: errors.length === 0 || newAnnouncementsCount > 0,
        newAnnouncementsCount: newAnnouncementsCount + addressedCount,
        error: errors.length > 0 ? errors.join(', ') : undefined,
      };
    } catch (error) {
      log.error('unexpected error during fetch/process', error);
      dlog('sessions', 'announcement.cycle.failed', errFields(error), {
        lvl: 'error',
        dur: since(cycleStarted),
      });
      return {
        success: false,
        newAnnouncementsCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.isProcessingAnnouncements = false;
    }
  }

  /**
   * Persist the bulletin polling cursor for the current user.
   * Stored in a dedicated announcementCursors table (not userProfile).
   */
  private async _upsertLastBulletinCounter(nextCounter: string): Promise<void> {
    await this.queries.announcementCursors.upsert(
      this.session.userIdEncoded,
      nextCounter
    );
  }

  /**
   * Fetch the latest bulletin counter from the API and persist it so that
   * historical announcements (undecryptable by a new account) are skipped.
   * No-op if a counter already exists.
   */
  /**
   * @param prefetchedCounter - a `fetchBulletinCounter()` request the
   *   caller started earlier, so account creation does not wait a full
   *   network round trip at this point. Same semantics either way.
   */
  async skipHistoricalAnnouncements(
    prefetchedCounter?: Promise<string>
  ): Promise<void> {
    const log = logger.forMethod('skipHistoricalAnnouncements');
    const existing = await this.queries.announcementCursors.get(
      this.session.userIdEncoded
    );
    if (existing !== undefined) return;

    try {
      const counter = await (prefetchedCounter ??
        this.messageProtocol.fetchBulletinCounter());
      await this._upsertLastBulletinCounter(counter);
      log.info('set initial bulletin counter for new account', { counter });
    } catch (err) {
      // Non-critical — on failure the first fetch starts from the beginning.
      log.warn('failed to initialize bulletin counter', { err });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Consumer-facing aliases
  // ─────────────────────────────────────────────────────────────────

  /** Fetch and process announcements from the protocol (alias) */
  async fetch(): Promise<AnnouncementReceptionResult> {
    return this.fetchAndProcessAnnouncements();
  }

  /** Skip historical announcements for a new account (alias) */
  async skipHistorical(prefetchedCounter?: Promise<string>): Promise<void> {
    return this.skipHistoricalAnnouncements(prefetchedCounter);
  }

  /** Account whose saved secondary cursors the transport holds. */
  private cursorsRestoredFor?: string;
  /** Secondary cursors as last saved, JSON. */
  private savedCursors?: string;

  /** Gives the transport the secondary cursors saved for this account, once. */
  private async _restoreTransportCursors(): Promise<void> {
    const protocol = this.messageProtocol;
    const userId = this.session.userIdEncoded;
    if (
      !protocol.importSecondaryCursors ||
      this.cursorsRestoredFor === userId
    ) {
      return;
    }
    this.cursorsRestoredFor = userId;
    const saved = await this.queries.transportCursors.get(userId);
    if (saved) protocol.importSecondaryCursors(saved);
    this.savedCursors = JSON.stringify(protocol.exportSecondaryCursors?.());
  }

  /** Saves the secondary cursors once what they cover has been processed. */
  private async _persistTransportCursors(): Promise<void> {
    const cursors = this.messageProtocol.exportSecondaryCursors?.();
    if (!cursors) return;
    const json = JSON.stringify(cursors);
    if (json === this.savedCursors) return;
    await this.queries.transportCursors.upsert(
      this.session.userIdEncoded,
      cursors
    );
    this.savedCursors = json;
  }

  private async _fetchAnnouncements(
    cursor?: string,
    limit?: number
  ): Promise<BulletinItem[]> {
    const fetchLimit = limit ?? this.config.announcements.fetchLimit;
    const log = logger.forMethod('_fetchAnnouncements');

    await this._restoreTransportCursors();
    try {
      const items = await this.messageProtocol.fetchAnnouncements(
        fetchLimit,
        cursor
      );
      return items;
    } catch (error) {
      log.error('network fetch failed', error);
      return [];
    }
  }

  /** Answers a peer's announcement now: a new one from us, made as an answer. */
  private async _answer(contactUserId: string): Promise<void> {
    this.answering.add(contactUserId);
    try {
      await this.connections?.accept(contactUserId);
    } catch {
      logger.error('announcement not answered');
    } finally {
      this.answering.delete(contactUserId);
    }
  }

  /**
   * A new announcement of a connection that does not answer ours: answered
   * now, or, within ten minutes of the last answer to that peer, once they
   * end (`_answerOwedRenewals`). The ten minutes end any exchange of
   * answers; deferring rather than dropping keeps a peer that announced
   * itself again soon (restored twice) from waiting for good.
   */
  private async _answerRenewal(
    discussionId: number,
    contactUserId: string,
    answeredAt: Date | null
  ): Promise<void> {
    const now = this.now();
    if (
      answeredAt !== null &&
      now - answeredAt.getTime() < CONNECTION_RENEWAL_ANSWER_MS
    ) {
      await this.queries.discussions.updateById(discussionId, {
        renewalAnswerOwed: true,
      });
      return;
    }
    await this.queries.discussions.updateById(discussionId, {
      renewalAnsweredAt: new Date(now),
      renewalAnswerOwed: false,
    });
    await this._answer(contactUserId);
  }

  /**
   * Answers, once, each peer owed an answer whose ten minutes have ended
   * and whose session is still active: the answer pairs with its latest
   * announcement.
   */
  private async _answerOwedRenewals(): Promise<void> {
    if (!this.connections) return;
    const now = this.now();
    const rows = await this.queries.discussions.getByOwner(
      this.session.userIdEncoded
    );
    for (const row of rows) {
      if (!row.renewalAnswerOwed) continue;
      const at = row.renewalAnsweredAt?.getTime();
      if (at !== undefined && now - at < CONNECTION_RENEWAL_ANSWER_MS) {
        continue;
      }
      if (
        this.session.peerSessionStatus(decodeUserId(row.contactUserId)) !==
        SessionStatus.Active
      ) {
        continue;
      }
      await this._answerRenewal(row.id, row.contactUserId, null);
    }
  }

  private async _generateTemporaryContactName(
    ownerUserId: string
  ): Promise<string> {
    const newRequestContacts = await this.queries.contacts.getNamesByPrefix(
      ownerUserId,
      TEMPORARY_CONTACT_NAME_PREFIX
    );

    const numbers = newRequestContacts
      .map(contact =>
        isTemporaryContactName(contact.name)
          ? parseInt(
              contact.name.slice(TEMPORARY_CONTACT_NAME_PREFIX.length),
              10
            )
          : 0
      )
      .filter(number => number > 0);

    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    return `${TEMPORARY_CONTACT_NAME_PREFIX} ${next}`;
  }

  /**
   * Reads announcements peers addressed to us at the entries only the two of
   * us can find, following each chain while it moves. Covers re-announcements
   * a transport cannot bring through the board, such as a mesh. Mesh only:
   * the mailbox seekers are long-lived enough to identify a pair of contacts,
   * so an internet node is never asked for them.
   */
  private async _fetchAddressedAnnouncements(): Promise<number> {
    const log = logger.forMethod('_fetchAddressedAnnouncements');
    let processed = 0;
    if (!this.messageProtocol.isMeshEnabled?.()) return processed;
    for (let round = 0; round < MAX_ADDRESSED_ROUNDS; round++) {
      const mailboxes = this.session.getReannouncementMailboxKeys();
      if (mailboxes.length === 0) break;

      let entries: EncryptedMessage[] = [];
      try {
        entries = await this.messageProtocol.fetchMessages(mailboxes, {
          meshOnly: true,
        });
      } catch (error) {
        log.debug('addressed announcements not fetched', error);
      }
      const pushed =
        await this.queries.pendingEncryptedMessages.getBySeekers(mailboxes);
      entries = entries.concat(
        pushed.map(row => ({ seeker: row.seeker, ciphertext: row.ciphertext }))
      );

      let advanced = false;
      for (const entry of entries) {
        const announcement = this.session.openReannouncementMailboxRead(
          entry.seeker,
          entry.ciphertext
        );
        if (!announcement) continue;
        const result = await this._processIncomingAnnouncement(announcement);
        if (result.success && result.contactUserId) {
          processed++;
          advanced = true;
        }
      }
      if (pushed.length > 0) {
        await this.queries.pendingEncryptedMessages.deleteBySeekers(
          pushed.map(row => row.seeker)
        );
      }
      if (!advanced) break;
    }
    return processed;
  }

  private async _processIncomingAnnouncement(
    announcementData: Uint8Array
  ): Promise<{
    success: boolean;
    discussionId?: number;
    contactUserId?: string;
    error?: string;
  }> {
    const log = logger.forMethod('_processIncomingAnnouncement');

    // feed incoming announcement to session manager to decrypt and get the announcement result (we are the recipient of the announcement)
    const result =
      await this.session.feedIncomingAnnouncement(announcementData);

    // if the result is null, it means the announcement is not intended for us. It's not an error
    if (!result) {
      return { success: true };
    }

    // a replay of an announcement from a contact the user deleted: forget the
    // peer again instead of bringing the contact back
    const announcerId = result.announcer_public_keys.derive_id();
    const floor = await this.queries.discardedPeers.getFloor(
      this.session.userIdEncoded,
      encodeUserId(announcerId)
    );
    if (floor !== undefined && result.timestamp <= floor) {
      await this.session.peerDiscard(announcerId);
      log.info('ignored a replayed announcement from a deleted contact');
      return { success: true };
    }

    // Persist the mutated Rust session state to the blob NOW, before any
    // SQL row that derives from it (contact + discussion below) is
    // committed. The invariant we want is "blob ahead of SQL, never the
    // reverse" — that way a crash between here and the next refresh
    // either leaves both stores empty (clean) or leaves a peer in the
    // session manager without a Discussion (already swept by
    // `RefreshService.stateUpdate`'s orphan-peer cleanup). The reverse
    // ordering — SQL ahead of blob — produced the
    // "discussion-without-peer" orphan that survived reboot.
    await this.persistFlusher();

    log.info('announcement intended for us — decrypting');

    const { username, message } = decodeAnnouncementPayload(result.user_data);

    const announcerPkeys = result.announcer_public_keys;
    const contactUserIdRaw = announcerPkeys.derive_id();
    const contactUserId = encodeUserId(contactUserIdRaw);

    const sessionStatus = this.session.peerSessionStatus(contactUserIdRaw);
    log.info('announcement received', {
      contactUserId,
      status: sessionStatusToString(sessionStatus),
    });

    let contact = await this.queries.contacts.getByOwnerAndUser(
      this.session.userIdEncoded,
      contactUserId
    );
    const isNewContact = !contact;
    // A member of a group this device accepted: connected without a prompt,
    // and no conversation is created (§5.12). A connection whose peer asked
    // to become a contact (`requested`) is still a connection.
    // A request kept after its connection went with the last shared chat
    // is judged again, as a new peer would be.
    // A contact added on this device only (`added`) is answered exactly as
    // an automatic connection would be (D.91): connected while its session
    // lives, judged again as a new peer once it was revoked.
    const added =
      !isNewContact &&
      contact!.connection === 'added' &&
      (
        await this.queries.discussions.getByOwnerAndContact(
          this.session.userIdEncoded,
          contactUserId
        )
      )?.weAccepted === true;
    const automatic =
      added ||
      (isNewContact ||
      contact!.connection === 'requested' ||
      contact!.connection === 'added'
        ? ((await this.connections?.isCoMember(contactUserId)) ?? false)
        : contact!.connection === 'automatic');
    // A contact request always carries a payload, even with no name and no
    // message (`encodeContactRequestPayload`; a request of 0.1.0 or 0.1.1
    // carried its timer); the announcement of a connection, an answer or a
    // renewal carries none (`openConnection`, `createSessionForContact`).
    const carriesRequest = (result.user_data?.length ?? 0) > 0;
    // A member of a shared chat who also asks to become a contact (§5.12):
    // the connection is answered at once below, exactly as for any member,
    // so that the chat keeps flowing and the answer does not depend on the
    // user; the request and its message are kept and shown for the user
    // to accept or decline. Nothing sent depends on that answer.
    const asksContact = automatic && carriesRequest;

    if (isNewContact) {
      // Use extracted username if present, otherwise generate temporary name
      const name =
        automatic && !asksContact
          ? (username ?? '')
          : username ||
            (await this._generateTemporaryContactName(
              this.session.userIdEncoded
            ));

      await this.queries.contacts.insert({
        ownerUserId: this.session.userIdEncoded,
        userId: contactUserId,
        name,
        publicKeys: announcerPkeys.to_bytes(),
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
        connection: asksContact
          ? 'requested'
          : automatic
            ? 'automatic'
            : 'accepted',
      });

      contact = await this.queries.contacts.getByOwnerAndUser(
        this.session.userIdEncoded,
        contactUserId
      );
      log.info('created new contact', { contactUserId, name });
    } else if (
      asksContact &&
      (contact!.connection === 'automatic' || contact!.connection === 'added')
    ) {
      await this.queries.contacts.updateByOwnerAndUser(
        this.session.userIdEncoded,
        contactUserId,
        {
          connection: 'requested',
          ...(contact!.name
            ? {}
            : {
                name:
                  username ||
                  (await this._generateTemporaryContactName(
                    this.session.userIdEncoded
                  )),
              }),
        }
      );
      contact = await this.queries.contacts.getByOwnerAndUser(
        this.session.userIdEncoded,
        contactUserId
      );
    }

    if (!contact) {
      log.error('contact lookup failed after creation');
      throw new Error('Could not find or create contact');
    }

    const keepsRequest = !automatic || asksContact;
    const { discussionId } = await this._handleReceivedDiscussion(
      this.session.userIdEncoded,
      contactUserId,
      keepsRequest ? message : undefined,
      automatic,
      asksContact
    );

    const row = await this.queries.discussions.getById(discussionId);
    const answersOurs = row?.awaitingAnswer === true;
    if (answersOurs) {
      await this.queries.discussions.updateById(discussionId, {
        awaitingAnswer: false,
      });
    }
    const statusNow = this.session.peerSessionStatus(contactUserIdRaw);
    if (!isNewContact && statusNow === SessionStatus.Active && !answersOurs) {
      // The peer's new announcement replaced an active session (it renewed
      // it, or it was restored from a copy, or it added us back): what was
      // sent on the old one may never be read. The group engine is told, as
      // for a renewal of ours, and scans the peer.
      if (row) {
        this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, toDiscussion(row));
      }
    }
    dlog(
      'sessions',
      'announcement.handled',
      {
        peer: shortId(contactUserId),
        newContact: isNewContact,
        automatic,
        answersOurs,
        status: statusNow,
        action:
          automatic && statusNow === SessionStatus.PeerRequested
            ? 'answer'
            : statusNow === SessionStatus.Active && !answersOurs
              ? 'answer-renewal'
              : statusNow === SessionStatus.PeerRequested
                ? 'wait-for-user'
                : 'none',
        peerRenewed:
          !isNewContact && statusNow === SessionStatus.Active && !answersOurs,
      },
      { lvl: 'info' }
    );
    if (
      (automatic && statusNow === SessionStatus.PeerRequested) ||
      (statusNow === SessionStatus.Active && !answersOurs)
    ) {
      // A peer that announced itself anew without answering ours: a member
      // who revoked its connection to us when it left a group and opens it
      // again once added back, or a contact restored from its recovery
      // phrase, or who removed us and added us back. The session it just
      // made pairs our earlier announcement, which it no longer holds, so it
      // waits for a new one from us. A contact the user accepted is answered
      // too: taking its new announcement and re-keying the session without
      // asking is already what a forced reset does, where the peer still
      // holds our earlier announcement; here the only piece missing is ours,
      // and answering gives the peer no power it did not have. A first
      // request from someone the user has not accepted still waits for the
      // user (PeerRequested is answered for a connection only).
      if (statusNow === SessionStatus.PeerRequested) {
        await this._answer(contactUserId);
      } else if (row) {
        await this._answerRenewal(
          discussionId,
          contactUserId,
          row.renewalAnsweredAt
        );
      }
    }

    // Store announcement message as an incoming message if present
    if (message && keepsRequest) {
      const timestamp = new Date(result.timestamp);
      const windowStart = new Date(timestamp.getTime() - 1000);
      const windowEnd = new Date(timestamp.getTime() + 1000);

      const existing = await this.queries.messages.getAnnouncementsByContact(
        this.session.userIdEncoded,
        contactUserId
      );

      // Filter in JS for content match and timestamp window (SQLite timestamp_ms comparison)
      const duplicate = existing.find(
        msg =>
          msg.content === message &&
          msg.timestamp >= windowStart &&
          msg.timestamp <= windowEnd
      );

      if (!duplicate) {
        await this.queries.messages.insert({
          ownerUserId: this.session.userIdEncoded,
          contactUserId,
          content: message,
          type: MessageType.ANNOUNCEMENT,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.READ,
          timestamp,
        });
      }
    }

    await this.refreshService?.stateUpdate();
    try {
      await this.connections?.processed(contactUserId);
    } catch {
      log.error('announcement not reported');
    }

    return {
      success: true,
      discussionId,
      contactUserId,
    };
  }

  private async _handleReceivedDiscussion(
    ownerUserId: string,
    contactUserId: string,
    message?: string,
    automatic = false,
    asksContact = false
  ): Promise<{ discussionId: number }> {
    const log = logger.forMethod('handleReceivedDiscussion');

    const existing = await this.queries.discussions.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );

    if (existing) {
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (message) updateData.announcementMessage = message;

      log.info('updating existing discussion', {
        discussionId: existing.id,
        contactUserId,
      });

      await this.queries.discussions.updateById(existing.id, updateData);

      // reset pending outgoing messages to WAITING_SESSION for this contact
      // Only reset READY and SENT — DELIVERED messages should not be resent.
      await this.queries.messages.resetSendQueue(
        this.session.userIdEncoded,
        contactUserId
      );

      const newDiscussion = await this.queries.discussions.getById(existing.id);
      const contactRow = await this.queries.contacts.getByOwnerAndUser(
        ownerUserId,
        contactUserId
      );
      if (
        newDiscussion &&
        contactRow &&
        (asksContact ||
          (!automatic &&
            this.session.peerSessionStatus(decodeUserId(contactUserId)) ===
              SessionStatus.PeerRequested))
      ) {
        this.eventEmitter.emit(SdkEventType.SESSION_REQUESTED, {
          discussion: toDiscussion(newDiscussion),
          contact: contactRow,
        });
      }
      return { discussionId: existing.id };
    }

    log.info('creating new discussion', { contactUserId });
    const discussionId = await this.queries.discussions.insert({
      ownerUserId,
      contactUserId,
      direction: DiscussionDirection.RECEIVED,
      announcementMessage: message,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await this.queries.discussions.getById(discussionId);
    const contactRow = await this.queries.contacts.getByOwnerAndUser(
      ownerUserId,
      contactUserId
    );
    if ((!automatic || asksContact) && discussion && contactRow) {
      this.eventEmitter.emit(SdkEventType.SESSION_REQUESTED, {
        discussion: toDiscussion(discussion),
        contact: contactRow,
      });
    }

    return { discussionId };
  }
}
