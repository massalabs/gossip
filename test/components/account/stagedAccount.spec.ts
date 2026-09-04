import { describe, expect, it } from 'vitest';
import {
  readStagedMnemonic,
  readStagedPassword,
  stageAccount,
  stagedMnemonicsEqual,
  stagedPasswordsEqual,
  wipeStagedAccounts,
} from '../../../src/components/account/stagedAccount';

describe('staged onboarding accounts', () => {
  it('keeps passwords in wipeable UTF-8 buffers', () => {
    const account = stageAccount('alice', 'correct horse battery staple');

    expect(ArrayBuffer.isView(account.passwordBytes)).toBe(true);
    expect(readStagedPassword(account)).toBe('correct horse battery staple');
  });

  it('keeps imported mnemonics in wipeable UTF-8 buffers', () => {
    const account = stageAccount(
      'alice',
      'unique password',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );

    expect(ArrayBuffer.isView(account.mnemonicBytes)).toBe(true);
    expect(readStagedMnemonic(account)).toContain('abandon abandon');
  });

  it('compares staged passwords without converting them back to strings', () => {
    const first = stageAccount('alice', 'shared password');
    const second = stageAccount('decoy', 'shared password');
    const third = stageAccount('other', 'different password');

    expect(stagedPasswordsEqual(first, second)).toBe(true);
    expect(stagedPasswordsEqual(first, third)).toBe(false);
  });

  it('compares imported identities without converting them back to strings', () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const first = stageAccount('alice', 'first password', mnemonic);
    const duplicate = stageAccount('decoy', 'second password', mnemonic);
    const generated = stageAccount('other', 'third password');

    expect(stagedMnemonicsEqual(first, duplicate)).toBe(true);
    expect(stagedMnemonicsEqual(first, generated)).toBe(false);
  });

  it('zeroizes every staged secret buffer', () => {
    const accounts = [
      stageAccount(
        'alice',
        'first password',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      ),
      stageAccount('decoy', 'second password'),
    ];

    wipeStagedAccounts(accounts);

    for (const account of accounts) {
      expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
      expect(account.mnemonicBytes?.every(byte => byte === 0) ?? true).toBe(
        true
      );
    }
  });
});
