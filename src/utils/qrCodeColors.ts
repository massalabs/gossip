/**
 * Get theme colors from CSS variables
 */
export const getThemeColor = (variable: string): string => {
  if (typeof window === 'undefined') return '#000000';
  const root = document.documentElement;
  return getComputedStyle(root).getPropertyValue(variable).trim();
};

/**
 * Normalize color to a valid CSS color string for qr-code-styling
 * Handles various color formats including space-separated HSL values
 */
export const normalizeColor = (color: string): string => {
  const trimmed = color.trim();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('rgb') ||
    trimmed.startsWith('hsl')
  ) {
    return trimmed;
  }
  // Check for space-separated HSL values (e.g., "220 13% 91%")
  if (/^\d+\s+\d+%\s+\d+%$/.test(trimmed)) {
    return `hsl(${trimmed})`;
  }
  // Fallback to black if unrecognized
  return '#000000';
};

/**
 * Get normalized foreground color based on theme
 */
export const getForegroundColor = (
  resolvedTheme: 'light' | 'dark',
  customColor?: string
): string => {
  const color =
    customColor ||
    (resolvedTheme === 'dark'
      ? getThemeColor('--foreground') || '#e8e8ea'
      : getThemeColor('--foreground') || '#1a1a1d');
  return normalizeColor(color);
};

/**
 * Get normalized background color based on theme
 */
export const getBackgroundColor = (
  resolvedTheme: 'light' | 'dark',
  customColor?: string
): string => {
  const color =
    customColor ||
    (resolvedTheme === 'dark'
      ? getThemeColor('--card') || '#1e1e22'
      : getThemeColor('--card') || '#ffffff');
  return normalizeColor(color);
};
