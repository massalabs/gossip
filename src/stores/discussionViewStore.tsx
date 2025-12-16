import { create } from 'zustand';
import { createSelectors } from './utils/createSelectors';

export interface DiscussionViewState {
  // Whether the viewport is currently at (or very near) the bottom
  isAtBottom: boolean;
  // Whether the “scroll to latest / X new messages” pill should be visible
  showScrollToLatest: boolean;
  // Number of unseen incoming messages below the current viewport
  unseenNewCount: number;
  // Index of the first new incoming message that arrived while scrolled up
  firstNewIndex: number | null;
}

interface DiscussionViewStoreState {
  // Keyed by contactUserId so multiple components can coordinate per discussion
  viewsByContact: Record<string, DiscussionViewState>;

  setViewState: (
    contactUserId: string,
    partial: Partial<DiscussionViewState>
  ) => void;
  resetViewState: (contactUserId: string) => void;
}

const defaultViewState: DiscussionViewState = {
  isAtBottom: true,
  showScrollToLatest: false,
  unseenNewCount: 0,
  firstNewIndex: null,
};

const useDiscussionViewStoreBase = create<DiscussionViewStoreState>(set => ({
  viewsByContact: {},

  setViewState: (contactUserId, partial) =>
    set(state => {
      const prev = state.viewsByContact[contactUserId] ?? defaultViewState;

      return {
        viewsByContact: {
          ...state.viewsByContact,
          [contactUserId]: {
            ...prev,
            ...partial,
          },
        },
      };
    }),

  resetViewState: contactUserId =>
    set(state => {
      const { [contactUserId]: _removed, ...rest } = state.viewsByContact;
      return { viewsByContact: rest };
    }),
}));

export const useDiscussionViewStore = createSelectors(
  useDiscussionViewStoreBase
);
