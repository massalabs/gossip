/**
 * Pure route builder — only one job: turn pattern + params → string
 *
 * Usage:
 *   ROUTES.discussions()        → "/"                    (for <Route path> or NavLink to)
 *   ROUTES.discussion({ userId: '123' }) → "/discussion/123"
 *   ROUTES.discussion()         → "/discussion/:userId"  (perfect for React Router path)

 */

type RouteParams = Record<string, string | number>;
type RouteBuilder = (params?: RouteParams) => string;

const route = (pattern: string): RouteBuilder => {
  const paramNames = (pattern.match(/:[^/]+/g) || []).map(p => p.slice(1));

  const build = (params?: RouteParams): string => {
    // No params passed → return the raw pattern (with :param placeholders)
    if (params === undefined || paramNames.length === 0) {
      return pattern;
    }

    let path = pattern;
    const missing: string[] = [];

    paramNames.forEach(name => {
      const value = params[name];
      if (value === undefined || value === null) {
        missing.push(name);
      } else {
        path = path.replace(`:${name}`, encodeURIComponent(String(value)));
      }
    });

    if (missing.length > 0 && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[routes] Missing required params for ${pattern}: ${missing.join(', ')}`
      );
    }

    return path;
  };

  return build;
};

export enum AppRoute {
  default = '',
  welcome = 'welcome',
  setup = 'setup',
  invite = 'invite',
  wallet = 'wallet',
  settings = 'settings',
  newContact = 'new-contact',
  newDiscussion = 'new-discussion',
  contact = 'contact',
  discussion = 'discussion',
  discussions = 'discussions',
}

export const ROUTES = {
  // Public
  welcome: route(`/${AppRoute.welcome}`),
  setup: route(`/${AppRoute.setup}`),
  // `userId` is expected to be a gossip1... encoded user ID
  invite: route(`/${AppRoute.invite}/:userId`),

  // Main tabs
  discussions: route(`/${AppRoute.discussions}`),
  wallet: route(`/${AppRoute.wallet}`),
  settings: route(`/${AppRoute.settings}`),

  // Actions
  newContact: route(`/${AppRoute.newContact}`),
  newDiscussion: route(`/${AppRoute.newDiscussion}`),

  // Dynamic routes
  contact: route(`/${AppRoute.contact}/:userId`),
  discussion: route(`/${AppRoute.discussion}/:userId`),
  discussionSettings: route(
    `/${AppRoute.discussion}/:discussionId/${AppRoute.settings}`
  ),

  // Default
  default: route(`/${AppRoute.default}`),
} as const;
