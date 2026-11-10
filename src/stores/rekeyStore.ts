import { create } from 'zustand';

export type RekeyStatus = 'idle' | 'running' | 'success' | 'error';

interface RekeyState {
  status: RekeyStatus;
  /**
   * Set when the new generation is durable but this runtime could not
   * switch to it cleanly; the app must reload before storage is used again.
   */
  reloadRequired: boolean;
  setStatus: (status: RekeyStatus, reloadRequired?: boolean) => void;
}

/**
 * Progress of an in-place rekey (set/change password, refresh keys).
 *
 * The operation logs the user out before it touches storage, so it cannot
 * live in a Settings component. While the status is not `idle`, the app shows
 * a blocking screen instead of the login page, so nothing else can open
 * storage half-way through.
 */
export const useRekeyStore = create<RekeyState>(set => ({
  status: 'idle',
  reloadRequired: false,
  setStatus: (status, reloadRequired = false) =>
    set({ status, reloadRequired }),
}));
