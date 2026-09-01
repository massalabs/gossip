export interface StagedAccount {
  username: string;
  passwordBytes: Uint8Array;
  mnemonicBytes?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function stageAccount(
  username: string,
  password: string,
  mnemonic?: string
): StagedAccount {
  return {
    username,
    passwordBytes: encoder.encode(password),
    mnemonicBytes:
      mnemonic === undefined ? undefined : encoder.encode(mnemonic),
  };
}

export function readStagedPassword(account: StagedAccount): string {
  return decoder.decode(account.passwordBytes);
}

export function readStagedMnemonic(account: StagedAccount): string | null {
  return account.mnemonicBytes === undefined
    ? null
    : decoder.decode(account.mnemonicBytes);
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

export function stagedMnemonicsEqual(
  left: StagedAccount,
  right: StagedAccount
): boolean {
  if (left.mnemonicBytes === undefined || right.mnemonicBytes === undefined) {
    return false;
  }
  if (left.mnemonicBytes.length !== right.mnemonicBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < left.mnemonicBytes.length; index += 1) {
    difference |= left.mnemonicBytes[index] ^ right.mnemonicBytes[index];
  }
  return difference === 0;
}

export function wipeStagedAccounts(accounts: StagedAccount[]): void {
  for (const account of accounts) {
    account.passwordBytes.fill(0);
    account.mnemonicBytes?.fill(0);
  }
}
