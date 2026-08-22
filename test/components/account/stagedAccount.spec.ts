import { describe, expect, it } from 'vitest';
import {
  readStagedPassword,
  stageAccount,
  stagedPasswordsEqual,
  wipeStagedAccounts,
} from '../../../src/components/account/stagedAccount';

describe('staged onboarding accounts', () => {
  it('keeps passwords in wipeable UTF-8 buffers', () => {
    const account = stageAccount('alice', 'correct horse battery staple');

    expect(ArrayBuffer.isView(account.passwordBytes)).toBe(true);
    expect(readStagedPassword(account)).toBe('correct horse battery staple');
  });

  it('compares staged passwords without converting them back to strings', () => {
    const first = stageAccount('alice', 'shared password');
    const second = stageAccount('decoy', 'shared password');
    const third = stageAccount('other', 'different password');

    expect(stagedPasswordsEqual(first, second)).toBe(true);
    expect(stagedPasswordsEqual(first, third)).toBe(false);
  });

  it('zeroizes every staged password buffer', () => {
    const accounts = [
      stageAccount('alice', 'first password'),
      stageAccount('decoy', 'second password'),
    ];

    wipeStagedAccounts(accounts);

    for (const account of accounts) {
      expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  });
});
