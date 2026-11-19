import type {
  GroupLine,
  GroupMessage,
  GroupSummary,
} from '@massalabs/gossip-sdk';
import { formatDateTime } from './timeUtils';
import { safeName } from './groupName';

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
    case 'epochChange': {
      const owner = name(line.owner);
      const out: string[] = [];
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
      if (line.newOwner) {
        out.push(t('timeline.new_owner', { owner, name: name(line.newOwner) }));
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
          from: formatDateTime(new Date(line.from)),
          to: formatDateTime(new Date(line.to)),
        }),
      ];
  }
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
