const utf8 = new TextEncoder();

/** The size of a text in UTF-8 bytes, as byte limits count it. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/** Whether a size is close enough to its limit to show a counter: 90 % or more. */
export function nearByteLimit(bytes: number, max: number): boolean {
  return bytes * 10 >= max * 9;
}
