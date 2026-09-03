import { describe, expect, it, vi } from 'vitest';
import {
  ImportPassword,
  ImportPasswords,
} from '../../src/services/importPasswords';

describe('ImportPassword', () => {
  it('wipes the borrowed backing bytes synchronously on disposal', async () => {
    const password = ImportPassword.fromText('correct horse');
    let borrowed: Uint8Array | null = null;

    await password.use(bytes => {
      borrowed = bytes;
      expect(new TextDecoder().decode(bytes)).toBe('correct horse');
    });
    password.dispose();

    expect(password.disposed).toBe(true);
    expect(borrowed).not.toBeNull();
    expect(Array.from(borrowed!)).toEqual(
      Array.from({ length: borrowed!.byteLength }, () => 0)
    );
    await expect(password.use(() => undefined)).rejects.toThrow(
      'Import password was disposed'
    );
  });
});

describe('ImportPasswords', () => {
  it('retains an authenticated password until confirmed removal', async () => {
    const passwords = new ImportPasswords();
    let borrowed: Uint8Array | null = null;
    const loaded = await passwords.load('first secret', bytes => {
      borrowed = bytes;
      return { username: 'Alice' };
    });

    expect(loaded.value).toEqual({ username: 'Alice' });
    expect(typeof loaded.id).toBe('symbol');
    expect(passwords.size).toBe(1);
    await passwords.use(loaded.id, bytes => {
      expect(bytes).toBe(borrowed);
    });

    expect(passwords.remove(loaded.id)).toBe(true);
    expect(passwords.size).toBe(0);
    expect(Array.from(borrowed!)).toEqual(
      Array.from({ length: borrowed!.byteLength }, () => 0)
    );
    await expect(passwords.use(loaded.id, () => undefined)).rejects.toThrow(
      'Import password is unavailable'
    );
  });

  it('wipes a rejected candidate without retaining it', async () => {
    const passwords = new ImportPasswords();
    let borrowed: Uint8Array | null = null;

    await expect(
      passwords.load('wrong secret', bytes => {
        borrowed = bytes;
        throw new Error('No matching account');
      })
    ).rejects.toThrow('No matching account');

    expect(passwords.size).toBe(0);
    expect(Array.from(borrowed!)).toEqual(
      Array.from({ length: borrowed!.byteLength }, () => 0)
    );
  });

  it('admits only one password authentication at a time', async () => {
    const passwords = new ImportPasswords();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = passwords.load('first', async () => {
      await gate;
    });
    await vi.waitFor(() => expect(passwords.isLoading).toBe(true));

    await expect(passwords.load('second', () => undefined)).rejects.toThrow(
      'An import password is already loading'
    );
    expect(passwords.size).toBe(0);

    release();
    const loaded = await first;
    expect(passwords.size).toBe(1);
    passwords.remove(loaded.id);
  });

  it('immediately wipes retained and in-flight passwords on cancellation', async () => {
    const passwords = new ImportPasswords();
    let retainedBytes: Uint8Array | null = null;
    const retained = await passwords.load('retained', bytes => {
      retainedBytes = bytes;
    });
    let activeBytes: Uint8Array | null = null;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const active = passwords.load('active', async bytes => {
      activeBytes = bytes;
      await gate;
    });
    await vi.waitFor(() => expect(activeBytes).not.toBeNull());

    passwords.dispose();
    expect(Array.from(retainedBytes!)).toEqual(
      Array.from({ length: retainedBytes!.byteLength }, () => 0)
    );
    expect(Array.from(activeBytes!)).toEqual(
      Array.from({ length: activeBytes!.byteLength }, () => 0)
    );
    expect(passwords.size).toBe(0);
    expect(passwords.remove(retained.id)).toBe(false);

    release();
    await expect(active).rejects.toThrow('Import passwords were disposed');
    await expect(passwords.load('later', () => undefined)).rejects.toThrow(
      'Import passwords were disposed'
    );
  });
});
