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

/**
 * The texts of a timeline line, in the order they are shown. `me` is this
 * account: a line where it acts or is acted on has its own second-person
 * string, never "You" put in a third-person sentence.
 */
export function lineTexts(
  line: GroupLine,
  memberName: (userId: string) => string,
  t: (key: string, o?: Record<string, unknown>) => string,
  me?: string
): string[] {
  // Each name is isolated from the text around it (§5.11 rule 3).
  const iso = (s: string) => `\u2068${s}\u2069`;
  const name = (id: string) => iso(memberName(id));
  const names = (ids: string[]) => ids.map(name).join(', ');
  const others = (ids: string[]) => ids.filter(id => id !== me);
  const mine = (id: string) => me !== undefined && id === me;
  switch (line.type) {
    case 'founded':
      return [
        mine(line.owner)
          ? t('timeline.founded_by_you')
          : t('timeline.founded', { owner: name(line.owner) }),
      ];
    case 'joined':
      // An owner that gets its own group back from a member.
      return [
        mine(line.by)
          ? t('timeline.joined_by_you')
          : t('timeline.joined', { owner: name(line.by) }),
      ];
    case 'epochChange': {
      // `by` made the change: for a handover, the outgoing owner (§4.7).
      const byMe = mine(line.by);
      const owner = name(line.by);
      const out: string[] = [];
      // A handover first, then what it changed ("Hand over and leave": the
      // outgoing owner named the next one, then left).
      if (line.newOwner) {
        out.push(
          byMe
            ? t('timeline.new_owner_by_you', { name: name(line.newOwner) })
            : mine(line.newOwner)
              ? t('timeline.new_owner_you', { owner })
              : t('timeline.new_owner', { owner, name: name(line.newOwner) })
        );
      }
      if (line.added.some(mine)) out.push(t('timeline.joined', { owner }));
      const added = others(line.added);
      if (added.length) {
        out.push(
          byMe
            ? t('timeline.added_by_you', { names: names(added) })
            : t('timeline.added', { owner, names: names(added) })
        );
      }
      if (line.removed.some(mine)) {
        out.push(t('timeline.removed_you', { owner }));
      }
      const removed = others(line.removed);
      if (removed.length) {
        out.push(
          byMe
            ? t('timeline.removed_by_you', { names: names(removed) })
            : t('timeline.removed', { owner, names: names(removed) })
        );
      }
      if (line.left.some(mine)) out.push(t('timeline.you_left'));
      const left = others(line.left);
      if (left.length) out.push(t('timeline.left', { names: names(left) }));
      if (line.renamed !== null) {
        const renamed = iso(safeName(line.renamed) || '—');
        out.push(
          byMe
            ? t('timeline.renamed_by_you', { name: renamed })
            : t('timeline.renamed', { owner, name: renamed })
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
