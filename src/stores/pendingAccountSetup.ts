/**
 * Module-level credential storage for the plausible deniability setup flow.
 * Credentials are held in RAM only — never persisted or exposed to devtools.
 * Cleared after account creation completes.
 */
export interface PendingCredentials {
  username: string;
  password: string;
}

let mainCredentials: PendingCredentials | null = null;

export function setPendingMainCredentials(creds: PendingCredentials) {
  mainCredentials = creds;
}

export function getPendingMainCredentials(): PendingCredentials | null {
  return mainCredentials;
}

export function clearPendingMainCredentials() {
  mainCredentials = null;
}
