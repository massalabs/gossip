/**
 * A send refused because the server already holds another value at its
 * seeker (409). The session with the peer is behind what was already
 * published: a copy of the account was restored where no marker can tell
 * (a raw copy on the same installation), or another instance used it. What
 * is encrypted on it next is refused too, so the session is renewed in
 * place, once an hour at most per peer.
 */
import type { Queries } from '../db/queries/index.js';
import type { SessionModule } from '../wasm/session.js';
import type { DiscussionService } from './discussion.js';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter.js';
import { toDiscussion } from '../utils/discussions.js';
import { Logger } from '../utils/logs.js';

const logger = new Logger('SeekerConflicts');

/** At most one renewal for a conflict per peer in this time. */
export const SEEKER_CONFLICT_RENEWAL_MS = 60 * 60 * 1000;

export class SeekerConflictHandler {
  private running = new Map<string, Promise<boolean>>();

  constructor(
    private session: SessionModule,
    private queries: Queries,
    private discussions: DiscussionService,
    private eventEmitter: SdkEventEmitter,
    private now: () => number = () => Date.now()
  ) {}

  /**
   * Handles a 409 for a send to `contactUserId`, one at a time per peer.
   * Resolves whether the session was renewed: then its queued messages wait
   * for the new session (one-to-one ones are encrypted again, the group
   * engine assembles its content again); otherwise the refused ciphertext
   * is the caller's to drop.
   */
  handle(contactUserId: string): Promise<boolean> {
    const running = this.running.get(contactUserId);
    if (running) return running;
    const handling = this.renew(contactUserId)
      .catch(error => {
        logger.error('seeker conflict not handled', { error });
        return false;
      })
      .finally(() => this.running.delete(contactUserId));
    this.running.set(contactUserId, handling);
    return handling;
  }

  private async renew(contactUserId: string): Promise<boolean> {
    const owner = this.session.userIdEncoded;
    const row = await this.queries.discussions.getByOwnerAndContact(
      owner,
      contactUserId
    );
    const now = this.now();
    const last = row?.seekerConflictRenewedAt?.getTime();
    if (
      !row ||
      (last !== undefined && now - last < SEEKER_CONFLICT_RENEWAL_MS)
    ) {
      this.eventEmitter.emit(SdkEventType.SEEKER_CONFLICT, {
        contactUserId,
        renewed: false,
      });
      return false;
    }
    // Recorded first: a crash during the renewal does not renew again.
    await this.queries.discussions.updateById(row.id, {
      seekerConflictRenewedAt: new Date(now),
    });
    // The group ciphertexts waiting for this peer were encrypted on the
    // session given up; the engine sends their content again.
    await this.queries.groups.deleteOutboxByContact(owner, contactUserId);
    const renewed = await this.discussions.createSessionForContact(
      contactUserId,
      new Uint8Array(0)
    );
    if (!renewed.success) {
      logger.error('session not renewed after a seeker conflict', {
        error: renewed.error,
      });
      return false;
    }
    const after = await this.queries.discussions.getByOwnerAndContact(
      owner,
      contactUserId
    );
    if (after) {
      this.eventEmitter.emit(SdkEventType.SESSION_RENEWED, toDiscussion(after));
    }
    this.eventEmitter.emit(SdkEventType.SEEKER_CONFLICT, {
      contactUserId,
      renewed: true,
    });
    return true;
  }
}
