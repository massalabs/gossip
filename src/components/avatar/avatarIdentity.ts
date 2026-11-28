/**
 * Deterministic ring color for **other users’** avatars (`ContactAvatar` only).
 * The current user’s avatar uses `bg-primary` in `UserProfileAvatar`.
 * Same seed → same classes; theme tokens only (Tailwind → CSS variables in index.css).
 */

const AVATAR_SURFACE_PALETTE = [
  'bg-secondary/20 dark:bg-secondary/30', // coral
  'bg-chart-4/35 dark:bg-chart-4/30', // orchid
  'bg-warning/15 dark:bg-warning/22', // amber
  'bg-[#d9e2f1] dark:bg-[#3a4a6b]', // periwinkle blue
  'bg-[#f5e6d3] dark:bg-[#5a4a3a]', // peach tan
  'bg-[#f3d9ea] dark:bg-[#5a3a4f]', // rose lavender
] as const;

/** FNV-1a 32-bit — stable across JS engines for the same string. */
export function hashIdentityString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Tailwind classes for the circular background behind the head SVG.
 * @param seed — Prefer contact `userId`; otherwise display name (or any stable string).
 */
export function getAvatarSurfaceClass(seed: string): string {
  const s = seed.trim();
  if (!s) return AVATAR_SURFACE_PALETTE[0];
  const idx = hashIdentityString(s) % AVATAR_SURFACE_PALETTE.length;
  return AVATAR_SURFACE_PALETTE[idx];
}

/**
 * One colour per member for the author's name (designer's screen 04), from
 * the user ID, so that it is the same on every screen and every run.
 */
const NAME_COLORS = [
  'text-[#7c3aed] dark:text-[#c4b5fd]',
  'text-[#c2410c] dark:text-[#fdba74]',
  'text-[#be123c] dark:text-[#fda4af]',
  'text-[#0369a1] dark:text-[#7dd3fc]',
  'text-[#047857] dark:text-[#6ee7b7]',
  'text-[#a21caf] dark:text-[#f0abfc]',
] as const;

export function getAuthorNameClass(userId: string): string {
  return NAME_COLORS[hashIdentityString(userId) % NAME_COLORS.length];
}
