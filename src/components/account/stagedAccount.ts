export interface StagedAccount {
  username: string;
  passwordBytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function stageAccount(
  username: string,
  password: string
): StagedAccount {
  return {
    username,
    passwordBytes: encoder.encode(password),
  };
}

export function readStagedPassword(account: StagedAccount): string {
  return decoder.decode(account.passwordBytes);
}

export function stagedPasswordsEqual(
  left: StagedAccount,
  right: StagedAccount
): boolean {
  if (left.passwordBytes.length !== right.passwordBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < left.passwordBytes.length; index += 1) {
    difference |= left.passwordBytes[index] ^ right.passwordBytes[index];
  }
  return difference === 0;
}

export function wipeStagedAccounts(accounts: StagedAccount[]): void {
  for (const account of accounts) {
    account.passwordBytes.fill(0);
  }
}
