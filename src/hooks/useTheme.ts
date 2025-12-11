import { useUiStore } from '../stores/uiStore';
import { initStatusBar } from './useCapacitorBarColors';
import { Theme } from '../stores/uiStore';
import { resolveTheme } from '../utils/themeUtils';

// const handleChange = () => {
//   const theme = useUiStore.getState().theme;
//   if (theme === 'system') {
//     void updateTheme(theme);
//   }
// };

// export const initializeTheme = async () => {
//   await updateTheme(useUiStore.getState().theme);

//   // const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

//   // mediaQuery.addEventListener('change', handleChange);

//   useUiStore.subscribe((state, prevState) => {
//     if (state.theme !== prevState.theme) {
//       void updateTheme(state.theme);
//     }
//   });

//   await initStatusBar();
// };

/**
 * React hook to access and modify theme
 */
export function useTheme() {
  const theme = useUiStore(s => s.theme);
  const resolvedTheme = useUiStore(s => s.resolvedTheme);
  const setTheme = useUiStore(s => s.setTheme);

  const updateTheme = async (theme: Theme) => {
    const root = document.documentElement;
    const resolved = resolveTheme(theme);

    useUiStore.getState().setResolvedTheme(resolved);

    if (resolved === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  };

  const initTheme = async () => {
    await updateTheme(theme);

    // const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    // mediaQuery.addEventListener('change', handleChange);

    useUiStore.subscribe((state, prevState) => {
      if (state.theme !== prevState.theme) {
        void updateTheme(state.theme);
      }
    });
    await initStatusBar();
  };

  return {
    theme,
    setTheme,
    resolvedTheme,
    initTheme,
  };
}
