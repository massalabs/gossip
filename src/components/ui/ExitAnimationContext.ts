import { createContext } from 'react';

/** True when the subtree is the exiting overlay (slide-out animation);
 *  page-level scroll detection hooks use this to skip setting the global
 *  header-scrolled state, so the stale scrollTop of the leaving page doesn't
 *  clobber the base layer. */
export const ExitAnimationContext = createContext(false);
