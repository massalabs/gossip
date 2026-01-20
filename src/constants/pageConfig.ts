import { ROUTES } from './routes';

/**
 * Page configuration for the app.
 * Defines which pages show bottom navigation.
 */
export interface PageConfig {
  /** Show bottom navigation bar */
  showBottomNav: boolean;
}

/**
 * Default page configuration (no bottom nav)
 */
const defaultConfig: PageConfig = {
  showBottomNav: false,
};

/**
 * Pages that show bottom navigation
 */
const withBottomNav: PageConfig = {
  showBottomNav: true,
};

/**
 * Page configurations by route pattern.
 * Routes not listed here use defaultConfig (no bottom nav).
 */
export const PAGE_CONFIGS: Record<string, PageConfig> = {
  // Main pages with bottom nav
  [ROUTES.discussions()]: withBottomNav,
  [ROUTES.settings()]: withBottomNav,
};

/**
 * Get page configuration for a given route.
 * Falls back to defaultConfig if route is not configured.
 */
export function getPageConfig(route: string): PageConfig {
  return PAGE_CONFIGS[route] ?? defaultConfig;
}

/**
 * Check if a route should show bottom navigation
 */
export function shouldShowBottomNav(route: string): boolean {
  return getPageConfig(route).showBottomNav;
}
