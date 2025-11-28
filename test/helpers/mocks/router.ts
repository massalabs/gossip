/**
 * Router Mocks for Testing
 *
 * NOTE: For most tests, use renderWithRouter() which provides a real MemoryRouter.
 * Only use these mocks when testing hooks or utilities in isolation without rendering components.
 *
 * For component testing:
 * ```ts
 * // ✅ PREFERRED: Use real router
 * renderWithRouter(<MyComponent />, { initialEntries: ['/discussions'] });
 * ```
 *
 * For hook testing:
 * ```ts
 * // ✅ Use mocks only when necessary
 * vi.mock('react-router-dom', () => ({
 *   ...vi.importActual('react-router-dom'),
 *   useNavigate: () => mockNavigate,
 * }));
 * ```
 */

import { vi } from 'vitest';
import type { NavigateFunction } from 'react-router-dom';

/**
 * Mock navigate function for testing navigation without rendering components
 * Use this when testing custom hooks that call useNavigate()
 *
 * @example
 * ```ts
 * vi.mock('react-router-dom', () => ({
 *   ...vi.importActual('react-router-dom'),
 *   useNavigate: () => mockNavigate,
 * }));
 *
 * // In test
 * myHook.doSomething();
 * expect(mockNavigate).toHaveBeenCalledWith('/discussions');
 * ```
 */
export const mockNavigate = vi.fn<NavigateFunction>();

/**
 * Mock window.location for testing URL-based logic
 * Useful for testing deep links and URL parsing
 *
 * @example
 * ```ts
 * mockWindowLocation('https://app.gossip.com/invite/abc123');
 * expect(window.location.pathname).toBe('/invite/abc123');
 * ```
 */
export const mockWindowLocation = (url: string) => {
  const urlObj = new URL(url);
  delete (window as { location?: Location }).location;
  (window as { location: Location }).location = {
    href: url,
    origin: urlObj.origin,
    protocol: urlObj.protocol,
    host: urlObj.host,
    hostname: urlObj.hostname,
    port: urlObj.port,
    pathname: urlObj.pathname,
    search: urlObj.search,
    hash: urlObj.hash,
    reload: vi.fn(),
    replace: vi.fn(),
    assign: vi.fn(),
    ancestorOrigins: {} as DOMStringList,
    toString: () => url,
  };
};
