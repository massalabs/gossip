export interface ParsedQRCode {
  userId: string;
  name: string;
}

export function parseInviteQRCode(qrText: string): ParsedQRCode {
  if (!qrText?.trim()) throw new Error('Invalid invite QR code');

  const match = qrText.match(/\/invite\/([^/#?\s]+)\/([^/#?\s]+)/i);
  if (!match) throw new Error('Invalid invite QR code format');

  const userId = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);

  return { userId, name };
}
