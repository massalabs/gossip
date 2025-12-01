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

export const ROUTES = {
  // Public
  welcome: route('/welcome'),
  setup: route('/setup'),
  invite: route('/invite/:userId'),

  // Main tabs
  discussions: route('/'),
  wallet: route('/wallet'),
  settings: route('/settings'),

  // Actions
  newContact: route('/new-contact'),
  newDiscussion: route('/new-discussion'),

  // Dynamic routes
  contact: route('/contact/:userId'),
  discussion: route('/discussion/:userId'),
  discussionSettings: route('/discussion/:discussionId/settings'),

  // Default
  default: route('/'),
} as const;
