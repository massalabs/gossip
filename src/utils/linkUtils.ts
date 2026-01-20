/**
 * Represents a segment of text that can be either plain text or a link
 */
export interface TextSegment {
  type: 'text' | 'link';
  content: string;
  url?: string;
}

/**
 * Regular expression to match HTTP/HTTPS URLs
 * Matches:
 * - http://example.com
 * - https://example.com
 * - http://example.com/path
 * - https://example.com/path?query=value
 * - URLs with or without www
 * - URLs with ports
 */
const URL_REGEX = /(https?:\/\/[^\s]+)/gi;

/**
 * Validates that a URL is properly formatted and safe to use.
 * Only allows http:// and https:// protocols for security.
 *
 * @param url - The URL to validate
 * @returns true if the URL is valid and safe, false otherwise
 */
function isValidUrl(url: string): boolean {
  if (!url || !url.trim()) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    // Only allow http and https protocols for security
    const allowedProtocols = ['http:', 'https:'];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      return false;
    }
    return true;
  } catch {
    // Invalid URL format
    return false;
  }
}

/**
 * Counts occurrences of a specific character in a string.
 *
 * @param str - The string to check
 * @param char - The character to count
 * @returns The count of the character
 */
function countChar(str: string, char: string): number {
  let count = 0;
  for (const c of str) {
    if (c === char) {
      count++;
    }
  }
  return count;
}

/**
 * Removes trailing punctuation from URLs that's likely not part of the URL itself.
 * Common sentence-ending punctuation like periods, commas are removed.
 * Closing brackets/parentheses/braces are only removed if they're unbalanced
 * (no matching opening bracket within the URL).
 *
 * @param url - The URL to clean
 * @returns The cleaned URL
 */
function cleanTrailingPunctuation(url: string): string {
  // Always remove trailing sentence-ending punctuation (periods, commas, semicolons, etc.)
  // These are rarely part of URLs
  const alwaysRemovePunct = /[.,;:!]+$/;
  url = url.replace(alwaysRemovePunct, '');

  // Handle closing brackets/parentheses/braces - only remove if unbalanced
  const bracketPairs: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };

  // Check for trailing closing brackets
  let trailingBrackets = '';
  for (let i = url.length - 1; i >= 0; i--) {
    const char = url[i];
    if (char in bracketPairs) {
      trailingBrackets = char + trailingBrackets;
    } else {
      break;
    }
  }

  if (trailingBrackets) {
    const urlWithoutTrailing = url.slice(0, -trailingBrackets.length);

    // Check if trailing brackets are unbalanced (more closing than opening)
    let hasUnbalanced = false;
    for (const closingBracket of trailingBrackets) {
      const openingBracket = bracketPairs[closingBracket];
      const openingCount = countChar(urlWithoutTrailing, openingBracket);
      const closingCount = countChar(urlWithoutTrailing, closingBracket);

      // If there are more or equal closing brackets than opening brackets,
      // this trailing bracket is unbalanced and can be removed
      if (closingCount >= openingCount) {
        hasUnbalanced = true;
        break;
      }
    }

    // Only remove trailing brackets if they're unbalanced
    if (hasUnbalanced) {
      url = urlWithoutTrailing;
    }
  }

  // Handle trailing quotes - remove if they follow a valid URL character
  const validUrlEndChars = /[a-zA-Z0-9/=&%#_\-~?)$\]}]$/;
  url = url.replace(/['"`]+$/, (match, offset) => {
    const charBefore = url[offset - 1];
    if (charBefore && validUrlEndChars.test(charBefore)) {
      return '';
    }
    return match;
  });

  return url;
}

/**
 * Parses text and identifies HTTP/HTTPS URLs, returning an array of segments
 * that can be rendered as either plain text or clickable links.
 *
 * @param text - The text to parse
 * @returns Array of text segments (either plain text or links)
 *
 * @example
 * parseLinks("Check out https://example.com for more info")
 * // Returns:
 * // [
 * //   { type: 'text', content: 'Check out ' },
 * //   { type: 'link', content: 'https://example.com', url: 'https://example.com' },
 * //   { type: 'text', content: ' for more info' }
 * // ]
 */
export function parseLinks(text: string): TextSegment[] {
  if (!text) return [];

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex lastIndex to ensure we start from the beginning
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    // Add text before the URL
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: text.substring(lastIndex, match.index),
      });
    }

    // Extract the URL and clean trailing punctuation
    let url = match[0];
    const originalUrl = url;
    url = cleanTrailingPunctuation(url);

    // Validate the URL before adding it as a link segment
    // Invalid URLs are treated as plain text for security
    if (isValidUrl(url)) {
      // If we removed trailing punctuation, we need to adjust the lastIndex
      // to account for the removed characters so the next iteration starts correctly
      const removedChars = originalUrl.length - url.length;
      if (removedChars > 0) {
        // Adjust lastIndex to point to the end of the cleaned URL
        URL_REGEX.lastIndex = match.index + url.length;
      }

      segments.push({
        type: 'link',
        content: url,
        url: url,
      });

      lastIndex = URL_REGEX.lastIndex;
    } else {
      // Invalid URL - treat as plain text
      // Include the original matched text (with punctuation) as plain text
      segments.push({
        type: 'text',
        content: originalUrl,
      });

      lastIndex = URL_REGEX.lastIndex;
    }
  }

  // Add remaining text after the last URL
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.substring(lastIndex),
    });
  }

  // If no URLs were found, return the entire text as a single text segment
  if (segments.length === 0) {
    segments.push({
      type: 'text',
      content: text,
    });
  }

  return segments;
}

/**
 * Opens a URL in the system browser (on native) or new tab (on web).
 * On native platforms, Capacitor's WebView will automatically open external URLs
 * in the system browser. On web platforms, it opens in a new tab.
 *
 * @param url - The URL to open
 */
export function openUrl(url: string): void {
  if (!url) return;

  // Validate URL format
  try {
    new URL(url);
  } catch {
    console.warn('Invalid URL:', url);
    return;
  }

  // On Capacitor native platforms, window.open() automatically opens external URLs
  // in the system browser. On web, it opens in a new tab.
  // Using _blank ensures it doesn't navigate the current window
  window.open(url, '_blank', 'noopener,noreferrer');
}
