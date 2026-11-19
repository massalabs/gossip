/**
 * Displaying names safely (§5.11 of the group chats specification).
 *
 * Group names, local names and contact names reach the screen through these
 * helpers. The result is for display only: stored and relayed bytes are never
 * changed. React renders the result as plain text (rule 1); the component that
 * shows it adds `dir="auto"` and `unicode-bidi: isolate` (rule 3, isolation)
 * and the `safe-name` clipping (rule 7), see `SafeName`.
 */

/** C0, U+007F, C1, and the line and paragraph separators (rule 2). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u0085]/g;

/** Explicit direction controls (rule 3). */
const DIRECTION = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** Invisible characters always removed (rule 4). */
const INVISIBLE = /[\u200b\u2060\ufeff\u180e\u00ad]/g;

/** Zero-width joiner and non-joiner (rule 4: kept only inside a sequence). */
const JOINERS = /[\u200c\u200d]/;

interface GraphemeSegmenter {
  segment(s: string): Iterable<{ segment: string }>;
}

// Intl.Segmenter (ES2022) is not in the TypeScript libraries this app targets.
const SegmenterCtor = (
  Intl as unknown as {
    Segmenter?: new (
      locale: undefined,
      options: { granularity: 'grapheme' }
    ) => GraphemeSegmenter;
  }
).Segmenter;

const segmenter: GraphemeSegmenter | null = SegmenterCtor
  ? new SegmenterCtor(undefined, { granularity: 'grapheme' })
  : null;

function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), g => g.segment);
  return Array.from(s);
}

/**
 * Whether a joiner inside this grapheme cluster is part of a valid sequence:
 * it joins two non-space characters of the same cluster (an emoji sequence,
 * or a script ligature the segmenter keeps together).
 */
function keepJoiners(cluster: string): boolean {
  const chars = Array.from(cluster);
  return chars.every((c, i) => {
    if (!JOINERS.test(c)) return true;
    const before = chars[i - 1];
    const after = chars[i + 1];
    return (
      before !== undefined &&
      after !== undefined &&
      !JOINERS.test(before) &&
      !JOINERS.test(after) &&
      before.trim() !== '' &&
      after.trim() !== ''
    );
  });
}

/** Combining marks kept per cluster, so that stacks stay on the line (rule 7). */
const MAX_MARKS = 3;

function limitMarks(cluster: string): string {
  let marks = 0;
  return Array.from(cluster)
    .filter(c => !/\p{M}/u.test(c) || ++marks <= MAX_MARKS)
    .join('');
}

/** The longest name shown, in grapheme clusters (rule 6). */
export const NAME_MAX_GRAPHEMES = 48;

/**
 * A name made safe for display: one line, no direction controls, no invisible
 * characters, NFC, shortened by grapheme cluster with an ellipsis. Returns ''
 * when nothing visible is left.
 */
export function safeName(
  name: string | null | undefined,
  maxGraphemes = NAME_MAX_GRAPHEMES
): string {
  if (!name) return '';
  const cleaned = name
    .replace(CONTROL, ' ')
    .replace(DIRECTION, '')
    .replace(INVISIBLE, '');
  const kept = graphemes(cleaned)
    .map(g => (keepJoiners(g) ? g : g.replace(/[\u200c\u200d]/g, '')))
    .join('')
    .normalize('NFC');
  const visible = graphemes(kept)
    .map(limitMarks)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!visible) return '';
  const clusters = graphemes(visible);
  if (clusters.length <= maxGraphemes) return visible;
  return `${clusters.slice(0, maxGraphemes).join('').trimEnd()}…`;
}

/**
 * The name of a group as the list, the header and previews show it: the local
 * name when set, else the group name, else a name built from the members
 * (rule 5.11: an empty name is allowed), else `fallback`: a group with no
 * name and no one else left, such as a direct chat the other person declined.
 */
export function groupDisplayName(
  group: { name: string; localName: string | null; members: string[] },
  memberName: (userId: string) => string,
  me?: string,
  fallback = ''
): string {
  const local = safeName(group.localName);
  if (local) return local;
  const official = safeName(group.name);
  if (official) return official;
  const others = group.members.filter(m => m !== me);
  const names = others.slice(0, 3).map(memberName);
  const rest = others.length - names.length;
  return (
    safeName(rest > 0 ? `${names.join(', ')} +${rest}` : names.join(', ')) ||
    fallback
  );
}

/**
 * A name made safe (`safeName`) placed inside a sentence: isolated from the
 * direction of the surrounding text with first-strong isolate marks (§5.11
 * rule 3), which `safeName` removed from the name itself.
 */
export function isolate(safe: string): string {
  return `\u2068${safe}\u2069`;
}
