/**
 * The message timer of group chats (§7.7): how long after it is written a
 * message disappears on every device, in milliseconds; 0 keeps messages
 * forever. Only the owner of a group sets it, and each message keeps the
 * timer of the part of the chat it was written in.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "1 month": 28 days. */
export const MESSAGE_TIMER_MONTH_MS = 28 * DAY;

/** Forever: messages are kept. */
export const MESSAGE_TIMER_FOREVER = 0;

/**
 * The values the app offers, in the order shown, for a group and for the
 * account's default: 5, 15, 30 minutes; 1, 2, 4, 8, 12 hours; 1 to 6 days;
 * 1, 2, 3 weeks; 1 month; forever. 7 days is the same value as 1 week,
 * offered once, as "1 week".
 */
export const MESSAGE_TIMER_OPTIONS: number[] = [
  ...[5, 15, 30].map(n => n * MINUTE),
  ...[1, 2, 4, 8, 12].map(n => n * HOUR),
  ...[1, 2, 3, 4, 5, 6].map(n => n * DAY),
  ...[1, 2, 3].map(n => n * WEEK),
  MESSAGE_TIMER_MONTH_MS,
  MESSAGE_TIMER_FOREVER,
];

/** The seconds of the account's default retention for a timer offered. */
export function timerToRetentionSeconds(ms: number): number | null {
  return ms === MESSAGE_TIMER_FOREVER ? null : Math.round(ms / 1000);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The label of a timer: one of the values offered by its name ("1 hour",
 * "2 weeks", "1 month", "Forever"), any other as a plain duration ("1 day
 * 2 hours", "90 seconds"), set by another client.
 */
export function messageTimerLabel(ms: number, t: Translate): string {
  if (!(ms > 0)) return t('groups:timer.forever');
  if (ms === MESSAGE_TIMER_MONTH_MS) return t('groups:timer.month');
  if (MESSAGE_TIMER_OPTIONS.includes(ms)) {
    if (ms % WEEK === 0 && ms >= WEEK) {
      return t('groups:timer.weeks', { count: ms / WEEK });
    }
    if (ms % DAY === 0) return t('groups:timer.days', { count: ms / DAY });
    if (ms % HOUR === 0) return t('groups:timer.hours', { count: ms / HOUR });
    return t('groups:timer.minutes', { count: ms / MINUTE });
  }
  // A plain duration: days, hours, minutes and seconds.
  let rest = Math.ceil(ms / 1000);
  const parts: string[] = [];
  for (const [unit, seconds] of [
    ['days', 86_400],
    ['hours', 3_600],
    ['minutes', 60],
    ['seconds', 1],
  ] as const) {
    const n = Math.floor(rest / seconds);
    rest -= n * seconds;
    if (n > 0) {
      parts.push(t(`groups:timer.${unit}`, { count: n }));
    }
  }
  return parts.join(' ');
}

/**
 * The sentence for a timer: "Messages disappear after 1 hour", or "Messages
 * are kept".
 */
export function messageTimerSentence(ms: number, t: Translate): string {
  return ms > 0
    ? t('groups:timer.disappear_after', {
        duration: messageTimerLabel(ms, t),
      })
    : t('groups:timer.kept');
}
