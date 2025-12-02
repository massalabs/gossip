export const defineWindowLocation = (value: Location) => {
  Object.defineProperty(window, 'location', {
    value,
    writable: true,
  });
};

export const setWindowOrigin = (origin: string | null) => {
  const location = window.location;
  if (origin === null) {
    // @ts-expect-error - jsdom types
    delete window.location;
    // @ts-expect-error - jsdom types
    window.location = location;
    return;
  }

  defineWindowLocation({ ...location, origin });
};
