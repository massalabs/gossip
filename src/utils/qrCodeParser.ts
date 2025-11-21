/**
 * Parse QR code data to extract contact information
 * Supports multiple formats:
 * - Plain userId (Bech32 format)
 * - URL format: https://gossip.app/add/{userId}?name={name}
 * - URL format: /add/{userId}?name={name}
 * - Relative URL: /add/{userId}
 */
export interface ParsedQRCode {
  userId: string;
  name?: string;
}

/**
 * Parse QR code text and extract userId and optional name
 * @param qrText - The text content from the QR code
 * @returns Parsed contact information or null if invalid
 */
export function parseQRCode(qrText: string): ParsedQRCode | null {
  if (!qrText || typeof qrText !== 'string') {
    return null;
  }

  const trimmed = qrText.trim();

  // Try to parse as URL format first
  try {
    // Try parsing as full URL first (handles URL-encoded parameters properly)
    if (
      trimmed.includes('://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://')
    ) {
      const url = new URL(trimmed);
      if (url.pathname.startsWith('/add/')) {
        const userIdMatch = url.pathname.match(/\/add\/([^/]+)/);
        if (userIdMatch) {
          const userId = decodeURIComponent(userIdMatch[1]);
          const name = url.searchParams.get('name')
            ? decodeURIComponent(url.searchParams.get('name')!)
            : undefined;

          if (userId) {
            return { userId, name };
          }
        }
      }
    }

    // Check if it's a relative path with /add/
    // First, try to extract the path and query separately
    if (trimmed.startsWith('/add/')) {
      const parts = trimmed.split('?');
      const pathPart = parts[0]; // /add/{userId}
      const queryPart = parts[1]; // name=value&other=value

      const userIdMatch = pathPart.match(/\/add\/(.+)$/);
      if (userIdMatch) {
        const userId = decodeURIComponent(userIdMatch[1]);
        let name: string | undefined;

        // Parse query string if present
        if (queryPart) {
          try {
            const params = new URLSearchParams(queryPart);
            const nameParam = params.get('name');
            if (nameParam) {
              name = decodeURIComponent(nameParam);
            }
          } catch (err) {
            console.warn('Failed to parse query string:', err);
          }
        }

        if (userId) {
          return { userId, name };
        }
      }
    }

    // Fallback: try regex match for relative paths
    const urlMatch = trimmed.match(/\/add\/([^/?]+)(?:\?name=([^&]+))?/);
    if (urlMatch) {
      const userId = decodeURIComponent(urlMatch[1]);
      // For relative paths, try to parse query string properly
      let name: string | undefined;
      if (urlMatch[2]) {
        // Decode the name parameter
        name = decodeURIComponent(urlMatch[2]);
      } else if (trimmed.includes('?')) {
        // If there's a query string but regex didn't capture it, parse it manually
        const queryPart = trimmed.split('?')[1];
        if (queryPart) {
          try {
            const params = new URLSearchParams(queryPart);
            const nameParam = params.get('name');
            if (nameParam) {
              name = decodeURIComponent(nameParam);
            }
          } catch (err) {
            console.warn('Failed to parse query string:', err);
          }
        }
      }

      if (userId) {
        return { userId, name };
      }
    }
  } catch {
    // Not a valid URL, continue to check if it's a plain userId
  }

  // Check if it's a plain userId (Bech32 format typically starts with specific prefixes)
  // For Massa, userIds are Bech32 encoded and typically start with specific prefixes
  // We'll accept any non-empty string that doesn't look like a URL as a potential userId
  if (
    trimmed.length > 0 &&
    !trimmed.includes('://') &&
    !trimmed.startsWith('/')
  ) {
    // Validate it's not obviously invalid (contains spaces, special URL chars, etc.)
    // Bech32 format: typically alphanumeric with some special chars
    if (/^[a-zA-Z0-9]+/.test(trimmed)) {
      return { userId: trimmed };
    }
  }

  // If it looks like a relative path /add/ but didn't match above, try one more time
  if (trimmed.startsWith('/add/')) {
    const parts = trimmed.split('?');
    const pathPart = parts[0];
    const userIdMatch = pathPart.match(/\/add\/(.+)/);
    if (userIdMatch) {
      const userId = decodeURIComponent(userIdMatch[1]);
      if (userId) {
        let name: string | undefined;
        if (parts.length > 1) {
          const params = new URLSearchParams(parts[1]);
          name = params.get('name')
            ? decodeURIComponent(params.get('name')!)
            : undefined;
        }
        return { userId, name };
      }
    }
  }

  return null;
}
