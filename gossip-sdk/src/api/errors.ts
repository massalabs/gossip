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
 * A request no server answered: no route, a timeout, a reset connection, or
 * an answer that was not the API's (a captive portal). Unlike an HTTP error
 * status, it says the network is out of reach, not that the request is bad.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * The backend was not asked: it failed at the network level a moment ago and
 * the mesh carries the traffic meanwhile (see `CompositeMessageProtocol`).
 * Always transient.
 */
export class BackendPausedError extends Error {
  constructor() {
    super('The backend is paused after a network failure');
    this.name = 'BackendPausedError';
  }
}

/** Which kind of path a transport is. */
export type TransportKind = 'internet' | 'mesh';

export interface TransportFailure {
  kind: TransportKind;
  error: unknown;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A send or fetch that every transport it went to refused, with each one's
 * reason: the backend's alone would hide why the mesh did not take it.
 */
export class TransportsFailedError extends Error {
  constructor(readonly failures: TransportFailure[]) {
    super(failures.map(f => `${f.kind}: ${reasonOf(f.error)}`).join('; '));
    this.name = 'TransportsFailedError';
  }
}

/**
 * The reasons the mesh node gives when it refuses a blob for good
 * (`gossip-pools` `RejectReason`, through `MeshError::Refused`): another
 * value already holds the seeker, or the blob is malformed or expired. The
 * native layer passes the reason as text, in its Debug or Display form, so
 * both are recognised. Anything else (node stopped, pool full, a date in the
 * future from a clock that will catch up) may pass later.
 */
const MESH_KEY_TAKEN = /KeyTaken|key already taken/;
const MESH_INVALID =
  /PayloadTooLarge|payload too large|KeyTooLarge|key too large|KeyNotAllowed|key not allowed|\bKv\(|key-value entry rejected|\bExpired\b|rejected: expired|needs its seeker/;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether the mesh node refused a blob because its seeker holds another value. */
export function isMeshKeyTaken(error: unknown): boolean {
  return MESH_KEY_TAKEN.test(reasonOf(error));
}

/** Whether the mesh node refused a blob for good (see `MESH_INVALID`). */
export function isFinalMeshRefusal(error: unknown): boolean {
  return (
    isMeshKeyTaken(error) ||
    MESH_INVALID.test(reasonOf(error)) ||
    errorCode(error) === 'INVALID_ARGUMENT'
  );
}

/** A 4xx answer other than a timeout (408) or rate limiting (429). */
export function isFinalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isFinalHttp(error: unknown): boolean {
  const status = /HTTP (\d{3})/.exec(reasonOf(error));
  return status !== null && isFinalStatus(Number(status[1]));
}

/**
 * Whether a send was refused because the server already holds another value
 * at its seeker (409): the session that produced it is behind what was
 * already published (a copy of the account restored, or a second instance).
 *
 * When several transports refused it: a server's 409 is enough, as before
 * the mesh answered on its own (the peer reads the server's value). A mesh
 * that holds another value counts only when no transport may take it later:
 * a mesh node's store is one phone's view, and the backend still decides.
 */
export function isSeekerConflict(error: unknown): boolean {
  if (error instanceof TransportsFailedError) {
    if (
      error.failures.some(
        f => f.kind === 'internet' && isSeekerConflict(f.error)
      )
    ) {
      return true;
    }
    return (
      error.failures.some(f => f.kind === 'mesh' && isMeshKeyTaken(f.error)) &&
      error.failures.every(f => isFinalFailure(f))
    );
  }
  return error instanceof HttpStatusError && error.status === 409;
}

function isFinalFailure(f: TransportFailure): boolean {
  return f.kind === 'mesh' ? isFinalMeshRefusal(f.error) : isFinalHttp(f.error);
}

/**
 * Whether a send failed for good: the server answered a 4xx other than a
 * timeout or rate limiting, or the mesh refused the blob itself. When
 * several transports refused it, only if every one did for good: one that
 * may take it later is worth the retry.
 */
export function isFinalSendError(error: unknown): boolean {
  if (error instanceof TransportsFailedError) {
    return error.failures.every(f => isFinalFailure(f));
  }
  return isFinalHttp(error);
}
