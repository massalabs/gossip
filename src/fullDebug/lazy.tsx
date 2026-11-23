/**
 * The pieces of the full debug build the app's pages show. Null in any other
 * build, where FULL_DEBUG is a constant false and the imports are dropped.
 */
import {
  lazy,
  Suspense,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FULL_DEBUG } from '../config/fullDebug';

function guarded<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>
): ComponentType<P> {
  const Lazy = lazy(() =>
    load().catch(() => ({ default: (() => null) as ComponentType<P> }))
  );
  const Wrapped = (props: P) => (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  );
  return Wrapped;
}

// `FULL_DEBUG ? ... : null` (not a test inside guarded) lets the bundler
// drop the import and its chunk from a normal build.
const FullDebugBanner = FULL_DEBUG
  ? guarded(() => import('./ui/Banner'))
  : null;

/**
 * Below the banner, the app sees a screen that starts where the banner ends:
 * the top inset is taken by the banner (--sat and the tokens built from it
 * at :root are 0 here), heights given as --available-height fill this box,
 * and the transform makes it the containing block of fixed elements
 * (modals, bottom sheets, the context menu), so that they cover the app
 * but never the banner.
 */
const FRAME_STYLE = {
  '--sat': '0px',
  '--spacing-safe-t': '0px',
  '--height-safe-t': '0px',
  '--spacing-header-safe': 'var(--header-height, 3.5rem)',
  '--height-header-safe': 'var(--header-height, 3.5rem)',
  '--available-height': '100%',
  transform: 'translateZ(0)',
} as CSSProperties;

/** The whole app, under the banner of the full debug build. */
export const FullDebugFrame = FULL_DEBUG
  ? ({ children }: { children: ReactNode }) => (
      <>
        {FullDebugBanner && <FullDebugBanner />}
        <div
          className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden"
          style={FRAME_STYLE}
        >
          {children}
        </div>
      </>
    )
  : null;
export const FullDebugActions = FULL_DEBUG
  ? guarded<{ settings?: boolean }>(() => import('./ui/Actions'))
  : null;
