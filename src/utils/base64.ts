export function encodeToBase64(data: Uint8Array): string {
  return btoa(
    Array.from(data)
      .map(byte => String.fromCharCode(byte))
      .join('')
  );
}

export function decodeFromBase64(b64: string): Uint8Array {
  const decoded = atob(b64);
  return new Uint8Array(Array.from(decoded).map(char => char.charCodeAt(0)));
}

export function encodeToBase64Url(data: Uint8Array): string {
  return btoa(
    Array.from(data)
      .map(byte => String.fromCharCode(byte))
      .join('')
  )
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function decodeFromBase64Url(base64url: string): Uint8Array {
  const base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');

  return decodeFromBase64(base64);
}
