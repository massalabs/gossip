import { Args } from '@massalabs/massa-web3';

export interface AnnouncementPayload {
  username?: string;
  message?: string;
}

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
    return { username, message };
  } catch {
    return { username: undefined, message: undefined };
  }
};
