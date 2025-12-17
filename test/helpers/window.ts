export const defineWindowLocation = (value: Location) => {
  Object.defineProperty(window, 'location', {
    value,
    writable: true,
  });
};

export const setWindowOrigin = (origin: string | null) => {
  const location = window.location;
  const nextOrigin = origin === null ? '' : origin;
  // Redefine the entire location object instead of the origin property only,
  // to avoid "Cannot redefine property: origin" errors in jsdom.
  defineWindowLocation({ ...location, origin: nextOrigin });
};
