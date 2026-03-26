import Head0 from '../../assets/head/Head-0.svg';
import Head1 from '../../assets/head/Head-1.svg';
import Head2 from '../../assets/head/Head-2.svg';
import Head3 from '../../assets/head/Head-3.svg';

const HEADS = [Head0, Head1, Head2, Head3] as const;

/** Decode the four bundled SVGs once so list navigation does not reload them per mount. */
function preloadHeadAssets(): void {
  if (typeof window === 'undefined') return;
  for (const url of HEADS) {
    const img = new Image();
    img.src = url;
  }
}
preloadHeadAssets();

/**
 * Returns a profile head image deterministically based on the first letter of the name.
 * Same name always produces the same head.
 */
export function getProfileHead(name: string): string {
  if (!name || name.length === 0) return HEADS[0];
  const index = name.charCodeAt(0) % HEADS.length;
  return HEADS[index];
}
