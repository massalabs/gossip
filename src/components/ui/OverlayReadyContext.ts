import { createContext, useContext } from 'react';

/**
 * Allows overlay pages (Discussion, etc.) to signal when their content is
 * rendered and ready to be shown. AnimatedRoutes waits for this signal
 * (with a safety timeout) before starting the slide animation, so the user
 * sees fully-rendered content from the first frame of the slide.
 */
interface OverlayReadyContextValue {
  signalReady: () => void;
}

export const OverlayReadyContext = createContext<OverlayReadyContextValue>({
  signalReady: () => {},
});

export const useOverlayReady = () => useContext(OverlayReadyContext);
