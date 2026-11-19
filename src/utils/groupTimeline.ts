import type {
  GroupLine,
  GroupMessage,
  GroupSummary,
} from '@massalabs/gossip-sdk';
import { formatDateTime } from './timeUtils';
import { safeName } from './groupName';

/** The largest time a Date holds, in ms (claimed times may be any u64). */
const MAX_DATE_MS = 8_640_000_000_000_000n;

/** A claimed time as a Date, clamped to what a Date can hold. */
export function toDate(ms: bigint): Date {
  return new Date(Number(ms > MAX_DATE_MS ? MAX_DATE_MS : ms));
}

/** The text a message shows (non-text bodies get a label). */
export function messageText(
  m: GroupMessage,
  t: (key: string) => string
): string {
  switch (m.body.type) {
    case 'text':
      return m.body.text;
    case 'media':
      return t('timeline.media');
    case 'reaction':
      return t('timeline.reaction');
    case 'forward':
      return t('timeline.forward');
  }
}

/** The texts of a timeline line, in the order they are shown. */
export function lineTexts(
  line: GroupLine,
  memberName: (userId: string) => string,
  t: (key: string, o?: Record<string, unknown>) => string
): string[] {
  // Each name is isolated from the text around it (§5.11 rule 3).
  const iso = (s: string) => `\u2068${s}\u2069`;
  const name = (id: string) => iso(memberName(id));
  const names = (ids: string[]) => ids.map(name).join(', ');
  switch (line.type) {
    case 'founded':
      return [t('timeline.founded', { owner: name(line.owner) })];
    case 'joined':
      return [t('timeline.joined', { owner: name(line.by) })];
    case 'epochChange': {
      // `by` made the change: for a handover, the outgoing owner (§4.7).
      const owner = name(line.by);
      const out: string[] = [];
      // A handover first, then what it changed ("Hand over and leave": the
      // outgoing owner named the next one, then left).
      if (line.newOwner) {
        out.push(t('timeline.new_owner', { owner, name: name(line.newOwner) }));
      }
      if (line.added.length)
        out.push(t('timeline.added', { owner, names: names(line.added) }));
      if (line.removed.length) {
        out.push(t('timeline.removed', { owner, names: names(line.removed) }));
      }
      if (line.left.length)
        out.push(t('timeline.left', { names: names(line.left) }));
      if (line.renamed !== null) {
        out.push(
          t('timeline.renamed', {
            owner,
            name: iso(safeName(line.renamed) || '—'),
          })
        );
      }
      return out;
    }
    case 'youWereRemoved':
      return [t('timeline.you_were_removed')];
    case 'youLeft':
      return [t('timeline.you_left')];
    case 'dissolved':
      return [t('timeline.dissolved')];
    case 'notAMember':
      return [
        t('timeline.not_a_member', {
          from: formatDateTime(toDate(line.from)),
          to: formatDateTime(toDate(line.to)),
        }),
      ];
    case 'addedBack':
      return [t('timeline.added_back', { owner: name(line.by) })];
  }
}

/**
 * Whether a send failed because the message is too large for a group packet
 * (§13.10): the engine refuses an event that does not fit one container.
 */
export function isTooLargeError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /does not fit one empty container|exceeds the container limit/.test(
      e.message
    )
  );
}

/** The reason the composer is disabled, as an i18n key, or null. */
export function composerBlockedReason(group: GroupSummary): string | null {
  switch (group.status) {
    case 'removed':
      return 'composer.disabled_removed';
    case 'left':
      return 'composer.disabled_left';
    case 'waiting':
      return 'composer.disabled_waiting';
    case 'dissolved':
    case 'dissolved-deleted':
      return 'composer.disabled_dissolved';
    default:
      return group.mustResolve ? 'composer.disabled_resolve' : null;
  }
}
