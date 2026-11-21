import { Args } from '@massalabs/massa-web3';

export interface AnnouncementPayload {
  username?: string;
  message?: string;
  /**
   * The message timer (§7.7, milliseconds, 0 keeps messages forever) of the
   * direct chat a contact request asks for, as its sender chose it: the
   * receiver sees it before accepting. Absent in a request of an earlier
   * version, and in any other announcement.
   */
  messageTimer?: number;
}

/**
 * The payload of an announcement: the username and the message, then the
 * message timer as a decimal string when one is stated. A reader of an
 * earlier version reads the first two and ignores the rest.
 */
export const encodeAnnouncementPayload = (
  username?: string,
  message?: string,
  messageTimer?: number
): Uint8Array | undefined => {
  const u = username?.trim() || '';
  const m = message?.trim() || '';
  const timer =
    messageTimer !== undefined &&
    Number.isSafeInteger(messageTimer) &&
    messageTimer >= 0
      ? messageTimer
      : undefined;

  if (!u && !m && timer === undefined) {
    return undefined;
  }

  const args = new Args().addString(u).addString(m);
  if (timer !== undefined) args.addString(String(timer));
  return args.serialize();
};

export const decodeAnnouncementPayload = (
  data?: Uint8Array
): AnnouncementPayload => {
  if (!data) {
    return { username: undefined, message: undefined };
  }

  let args: Args;
  let username: string | undefined;
  let message: string | undefined;
  try {
    args = new Args(data);
    username = args.nextString() || undefined;
    message = args.nextString() || undefined;
  } catch {
    return { username: undefined, message: undefined };
  }
  let messageTimer: number | undefined;
  try {
    const raw = args.nextString();
    if (/^[0-9]{1,15}$/.test(raw)) messageTimer = Number(raw);
  } catch {
    // An earlier version: no timer stated.
  }
  return messageTimer === undefined
    ? { username, message }
    : { username, message, messageTimer };
};
