import { describe, expect, it } from 'vitest';
import { getTestConnection } from '../testDb';

type RawConnection = {
  execRaw(sql: string, params?: unknown[]): Promise<unknown[][]>;
  execRawDirect(sql: string, params?: unknown[]): Promise<unknown[][]>;
};

function rawConnection(): RawConnection {
  return getTestConnection() as unknown as RawConnection;
}

describe('DatabaseConnection raw execution guards', () => {
  it('rejects undefined bind params on the public raw path', async () => {
    await expect(
      rawConnection().execRaw('SELECT ?', [undefined])
    ).rejects.toThrow(
      'SQLite bind param at index 0 is undefined; pass null explicitly if NULL is intended'
    );
  });

  it('rejects undefined bind params on the direct transaction path', async () => {
    await expect(
      rawConnection().execRawDirect('SELECT ?', [undefined])
    ).rejects.toThrow(
      'SQLite bind param at index 0 is undefined; pass null explicitly if NULL is intended'
    );
  });

  it('allows explicit null bind params', async () => {
    const rows = await rawConnection().execRawDirect('SELECT ? IS NULL', [
      null,
    ]);

    expect(rows).toEqual([[1]]);
  });
});
