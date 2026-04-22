// Import SVGs as raw strings so we can inline them directly instead of loading
// through <img src>. Inline SVG has no network/decode cost on remount (list
// navigation, virtualization) — the string is already in memory as JS.
import Head0 from '../../assets/head/Head-0.svg?raw';
import Head1 from '../../assets/head/Head-1.svg?raw';
import Head2 from '../../assets/head/Head-2.svg?raw';
import Head3 from '../../assets/head/Head-3.svg?raw';

// These SVGs ship with a `<clipPath id="clip0_…">` + matching
// `clip-path="url(#clip0_…)"` wrapper whose clip rect covers the full viewBox
// — visually a no-op. When the same head is inlined many times (discussion
// list, message list), every copy ends up with the *same* DOM id. iOS WebKit
// resolves `url(#…)` to the first match and clips later instances to nothing,
// so only the ring renders. Strip the clipPath once at module load.
function stripClipPath(svg: string): string {
  return svg
    .replace(/\s+clip-path="url\(#clip0_[^"]*\)"/g, '')
    .replace(
      /<defs>\s*<clipPath id="clip0_[^"]*">[\s\S]*?<\/clipPath>\s*<\/defs>/g,
      ''
    );
}

const HEADS = [
  stripClipPath(Head0),
  stripClipPath(Head1),
  stripClipPath(Head2),
  stripClipPath(Head3),
] as const;

/**
 * Returns a profile head SVG (as an HTML string) deterministically based on
 * the first letter of the name. Same name always produces the same head.
 */
export function getProfileHead(name: string): string {
  if (!name || name.length === 0) return HEADS[0];
  const index = name.charCodeAt(0) % HEADS.length;
  return HEADS[index];
}
