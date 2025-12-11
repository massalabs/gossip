import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { resolveTheme } from '../utils/themeUtils';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
interface UiStoreState {
  // Theme state
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;

  // Header visibility and scroll state
  headerVisible: boolean;
  setHeaderVisible: (visible: boolean) => void;
  headerIsScrolled: boolean;
  setHeaderIsScrolled: (isScrolled: boolean) => void;

  // Bottom navigation visibility
  bottomNavVisible: boolean;
  setBottomNavVisible: (visible: boolean) => void;
}

const useUiStoreBase = create<UiStoreState>()(
  persist(
    set => ({
      // Theme state
      theme: 'system',
      resolvedTheme: resolveTheme('system'),
      setTheme: (theme: Theme) => {
        set({ theme });
      },
      setResolvedTheme: (resolvedTheme: 'light' | 'dark') => {
        set({ resolvedTheme });
      },

      // Header visibility and scroll state
      headerVisible: false,
      setHeaderVisible: (visible: boolean) => {
        set({ headerVisible: visible });
      },
      headerIsScrolled: false,
      setHeaderIsScrolled: (isScrolled: boolean) => {
        set({ headerIsScrolled: isScrolled });
      },

      // Bottom navigation visibility
      bottomNavVisible: false,
      setBottomNavVisible: (visible: boolean) => {
        set({ bottomNavVisible: visible });
      },
    }),
    {
      name: STORAGE_KEYS.THEME,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        theme: state.theme,
      }),
    }
  )
);

export const useUiStore = createSelectors(useUiStoreBase);
