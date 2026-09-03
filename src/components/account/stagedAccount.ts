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

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function stagedPasswordsEqual(
  left: StagedAccount,
  right: StagedAccount
): boolean {
  return constantTimeBytesEqual(left.passwordBytes, right.passwordBytes);
}

export function stagedMnemonicsEqual(
  left: StagedAccount,
  right: StagedAccount
): boolean {
  if (left.mnemonicBytes === undefined || right.mnemonicBytes === undefined) {
    return false;
  }
  return constantTimeBytesEqual(left.mnemonicBytes, right.mnemonicBytes);
}

export function wipeStagedAccounts(accounts: StagedAccount[]): void {
  for (const account of accounts) {
    account.passwordBytes.fill(0);
    account.mnemonicBytes?.fill(0);
  }
}
