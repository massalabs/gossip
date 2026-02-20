/**
 * Time utility functions for formatting and manipulating dates
 */

/**
 * Format a date to show relative time for discussion list items.
 * - < 1 min: "now"
 * - < 60 min: "3m"
 * - Today (>= 60 min): "14:30"
 * - Yesterday: "Yesterday"
 * - < 7 days: weekday name (e.g. "Monday")
 * - Same year: "Jan 15"
 * - Older: "Jan 15, 2024"
 * @param date - The date to format
 * @returns Formatted relative time string
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;

  if (isToday(date)) return formatTime(date);
  if (isYesterday(date)) return 'Yesterday';

  const days = Math.floor(diff / 86400000);
  if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a date to show time in 24-hour format (e.g., "14:30")
 * @param date - The date to format
 * @returns Formatted time string
 */
export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Format a date to show a full date string (e.g., "12/25/2023")
 * @param date - The date to format
 * @returns Formatted date string
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}

/**
 * Format a date to show both date and time
 * @param date - The date to format
 * @returns Formatted date and time string
 */
export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

/**
 * Check if a date is today
 * @param date - The date to check
 * @returns True if the date is today
 */
export function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if a date is yesterday
 * @param date - The date to check
 * @returns True if the date is yesterday
 */
export function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  );
}

/**
 * Get a human-readable relative time with more context
 * @param date - The date to format
 * @returns More descriptive relative time string
 */
export function formatDetailedRelativeTime(date: Date): string {
  if (isToday(date)) {
    return `Today at ${formatTime(date)}`;
  }

  if (isYesterday(date)) {
    return `Yesterday at ${formatTime(date)}`;
  }

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);

  if (days < 7) {
    return `${days} days ago`;
  }

  return formatDate(date);
}

/**
 * Create a timestamp string for logging purposes
 * @param date - The date to format (defaults to now)
 * @returns Timestamp string in format "HH:MM:SS"
 */
export function createTimestamp(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format a date for use in date separators (e.g., "Today", "Yesterday", "January 15, 2024")
 * @param date - The date to format
 * @returns Formatted date string for separators
 */
export function formatDateSeparator(date: Date): string {
  if (isToday(date)) {
    return 'Today';
  }

  if (isYesterday(date)) {
    return 'Yesterday';
  }

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  // Calculate whole days difference; keep sign so future dates are not treated as past
  const days = Math.floor(diff / 86400000);

  // For dates within the last week (in the past), show day name
  // Only apply this logic for past dates (diff >= 0) to avoid misleading future date display
  if (diff >= 0 && days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  // For future dates, show the full date to avoid confusion
  if (diff < 0) {
    // Future date - show full date format
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
      });
    }
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  // For dates within the current year, show month and day
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
    });
  }

  // For older dates, show full date
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Check if two dates are on different days
 * @param date1 - First date
 * @param date2 - Second date
 * @returns True if the dates are on different days
 */
export function isDifferentDay(date1: Date, date2: Date): boolean {
  return (
    date1.getDate() !== date2.getDate() ||
    date1.getMonth() !== date2.getMonth() ||
    date1.getFullYear() !== date2.getFullYear()
  );
}
