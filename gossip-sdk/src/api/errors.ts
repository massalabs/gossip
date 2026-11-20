/** A request the server answered with an error status. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    statusText: string
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * Whether a send was refused because the server already holds another value
 * at its seeker (409): the session that produced it is behind what was
 * already published (a copy of the account restored, or a second instance).
 */
export function isSeekerConflict(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 409;
}
