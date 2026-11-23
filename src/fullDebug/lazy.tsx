/**
 * The pieces of the full debug build the app's pages show. Null in any other
 * build, where FULL_DEBUG is a constant false and the imports are dropped.
 */
import { lazy, Suspense, type ComponentType } from 'react';
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
export const FullDebugBanner = FULL_DEBUG
  ? guarded(() => import('./ui/Banner'))
  : null;
export const FullDebugActions = FULL_DEBUG
  ? guarded<{ settings?: boolean }>(() => import('./ui/Actions'))
  : null;
