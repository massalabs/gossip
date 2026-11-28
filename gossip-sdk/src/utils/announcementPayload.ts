import { Args } from '@massalabs/massa-web3';

export interface AnnouncementPayload {
  username?: string;
  message?: string;
}

/**
 * The payload of an announcement: the username and the message.
 *
 * A contact request of 0.1.0 or 0.1.1 also stated the message timer of the
 * chat it asked for, as a third field (a decimal string). Since adding a
 * contact no longer starts a chat (§5.12), no timer is sent, and one
 * received is read past and ignored.
 */
export const encodeAnnouncementPayload = (
  username?: string,
  message?: string
): Uint8Array | undefined => {
  const u = username?.trim() || '';
  const m = message?.trim() || '';

  if (!u && !m) {
    return undefined;
  }

  return new Args().addString(u).addString(m).serialize();
};

/**
 * The payload of a contact request: as `encodeAnnouncementPayload`, but
 * never empty, even with no username and no message. _Why:_ the
 * announcement that opens, answers or renews a connection carries no
 * payload, and a member of a shared chat tells a contact request from it by
 * that alone (§5.12).
 */
export const encodeContactRequestPayload = (
  username?: string,
  message?: string
): Uint8Array =>
  encodeAnnouncementPayload(username, message) ??
  new Args().addString('').addString('').serialize();

export const decodeAnnouncementPayload = (
  data?: Uint8Array
): AnnouncementPayload => {
  if (!data) {
    return { username: undefined, message: undefined };
  }

  try {
    const args = new Args(data);
    const username = args.nextString() || undefined;
    const message = args.nextString() || undefined;
    // A third field, the timer of a request of 0.1.0 or 0.1.1, is ignored.
    return { username, message };
  } catch {
    return { username: undefined, message: undefined };
  }
};
