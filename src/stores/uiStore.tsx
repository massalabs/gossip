import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { resolveTheme } from '../utils/themeUtils';
import i18n, { type SupportedLanguage } from '../i18n';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
interface UiStoreState {
  // Theme state
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (theme: ResolvedTheme) => void;

  // Language state
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;

  // Header visibility and scroll state
  headerVisible: boolean;
  setHeaderVisible: (visible: boolean) => void;
  headerIsScrolled: boolean;
  setHeaderIsScrolled: (isScrolled: boolean) => void;

  // Bottom navigation visibility
  bottomNavVisible: boolean;
  setBottomNavVisible: (visible: boolean) => void;

  // User preference: show bottom navigation bar
  showBottomNav: boolean;
  setShowBottomNav: (show: boolean) => void;
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

      // Language state
      language: (i18n.language?.startsWith('zh')
        ? 'zh-CN'
        : i18n.language?.substring(0, 2) || 'en') as SupportedLanguage,
      setLanguage: (language: SupportedLanguage) => {
        i18n.changeLanguage(language);
        set({ language });
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

      // User preference: show bottom navigation bar
      showBottomNav: false,
      setShowBottomNav: (show: boolean) => {
        set({ showBottomNav: show });
      },
    }),
    {
      name: STORAGE_KEYS.THEME,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        theme: state.theme,
        showBottomNav: state.showBottomNav,
        language: state.language,
      }),
      onRehydrateStorage: () => state => {
        if (state?.language && state.language !== i18n.language) {
          i18n.changeLanguage(state.language);
        }
      },
    }
  )
);

export const useUiStore = createSelectors(useUiStoreBase);
