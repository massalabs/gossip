import { describe, expect, it, vi } from 'vitest';
import { ImportedAccountPreviews } from '../../src/services/importedAccountPreviews';

const profile = {
  userId: 'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
  username: 'Alice',
  avatar: null,
  createdAtMs: 1234,
};

describe('imported account preview ownership', () => {
  it('retains a successful password behind an opaque runtime handle', async () => {
    const owner = new ImportedAccountPreviews();
    const loaded = await owner.authenticate('secret', async () => ({
      ...profile,
      slot: 2,
      security: 'must not escape',
    }));

    expect(typeof loaded.passwordId).toBe('symbol');
    expect(loaded).toEqual({ ...profile, passwordId: loaded.passwordId });
    expect(JSON.stringify(loaded)).not.toContain('passwordId');
    expect(JSON.stringify(loaded)).not.toContain('slot');
    expect(JSON.stringify(loaded)).not.toContain('security');
    await expect(
      owner.usePassword(loaded.passwordId, password =>
        new TextDecoder().decode(password)
      )
    ).resolves.toBe('secret');

    expect(owner.remove(loaded.passwordId)).toBe(true);
    await expect(
      owner.usePassword(loaded.passwordId, () => undefined)
    ).rejects.toThrow('preview is unavailable');
  });

  it('rejects duplicate authenticated identities and wipes the candidate', async () => {
    const owner = new ImportedAccountPreviews();
    await owner.authenticate('first', async () => profile);
    let rejectedCandidate: Uint8Array | null = null;

    await expect(
      owner.authenticate('second', async candidate => {
        rejectedCandidate = candidate;
        return profile;
      })
    ).rejects.toThrow('already accepted');
    expect(Array.from(rejectedCandidate!)).toEqual(
      Array.from({ length: rejectedCandidate!.byteLength }, () => 0)
    );
    expect(owner.list()).toHaveLength(1);
    owner.dispose();
  });

  it('rejects an invalid user ID checksum at the public boundary', async () => {
    const owner = new ImportedAccountPreviews();
    const invalidUserId = `${profile.userId.slice(0, -1)}q`;

    await expect(
      owner.authenticate('secret', async () => ({
        ...profile,
        userId: invalidUserId,
      }))
    ).rejects.toThrow('preview is invalid');
    expect(owner.list()).toEqual([]);
    owner.dispose();
  });

  it('clears previews and retained passwords on disposal', async () => {
    const owner = new ImportedAccountPreviews();
    const loaded = await owner.authenticate('secret', async () => profile);
    const operation = vi.fn();

    owner.dispose();

    expect(() => owner.list()).toThrow('disposed');
    await expect(
      owner.usePassword(loaded.passwordId, operation)
    ).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});
