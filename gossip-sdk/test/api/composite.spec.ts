import { describe, it, expect } from 'vitest';
import { CompositeMessageProtocol } from '../../src/api/messageProtocol/composite';
import type {
  IMessageProtocol,
  TransportConnectivity,
} from '../../src/api/messageProtocol/types';
import { MockMessageProtocol } from '../mocks';

const bytes = (...values: number[]) => new Uint8Array(values);

class DownProtocol extends MockMessageProtocol {
  down = true;
  private fail<T>(op: () => Promise<T>): Promise<T> {
    return this.down ? Promise.reject(new Error('unreachable')) : op();
  }
  override fetchMessages(seekers: Uint8Array[]) {
    return this.fail(() => super.fetchMessages(seekers));
  }
  override sendMessage(message: {
    seeker: Uint8Array;
    ciphertext: Uint8Array;
  }) {
    return this.fail(() => super.sendMessage(message));
  }
  override sendAnnouncement(announcement: Uint8Array) {
    return this.fail(() => super.sendAnnouncement(announcement));
  }
  override fetchAnnouncements(limit?: number, cursor?: string) {
    return this.fail(() => super.fetchAnnouncements(limit, cursor));
  }
}

function composite(primary: IMessageProtocol, mesh: IMessageProtocol) {
  return new CompositeMessageProtocol({ protocol: primary, kind: 'internet' }, [
    { protocol: mesh, kind: 'mesh' },
  ]);
}

describe('CompositeMessageProtocol', () => {
  it('sends on every transport and succeeds while one takes it', async () => {
    const internet = new DownProtocol();
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);

    await protocol.sendMessage({ seeker: bytes(1), ciphertext: bytes(9) });
    expect(mesh.getStoredMessages().size).toBe(1);
    expect(protocol.getConnectivity()).toBe('mesh-only');

    const mesh2 = new DownProtocol();
    await expect(
      composite(internet, mesh2).sendMessage({
        seeker: bytes(1),
        ciphertext: bytes(9),
      })
    ).rejects.toThrow('unreachable');
  });

  it('tells once which transports took a send', async () => {
    const internet = new DownProtocol();
    const protocol = composite(internet, new MockMessageProtocol());

    await protocol.sendMessage({ seeker: bytes(1), ciphertext: bytes(9) });
    expect(protocol.takeAcceptedBy(bytes(1))).toEqual(['mesh']);
    expect(protocol.takeAcceptedBy(bytes(1))).toBeUndefined();

    internet.down = false;
    await protocol.sendMessage({ seeker: bytes(2), ciphertext: bytes(9) });
    expect(protocol.takeAcceptedBy(bytes(2))).toEqual(['internet', 'mesh']);
  });

  it('merges exact copies and keeps distinct values in transport order', async () => {
    const internet = new MockMessageProtocol();
    const mesh = new MockMessageProtocol();
    await internet.sendMessage({ seeker: bytes(1), ciphertext: bytes(10) });
    await mesh.sendMessage({ seeker: bytes(1), ciphertext: bytes(10) });
    await mesh.sendMessage({ seeker: bytes(2), ciphertext: bytes(20) });
    await internet.sendMessage({ seeker: bytes(3), ciphertext: bytes(30) });
    await mesh.sendMessage({ seeker: bytes(3), ciphertext: bytes(31) });

    const fetched = await composite(internet, mesh).fetchMessages([
      bytes(1),
      bytes(2),
      bytes(3),
    ]);
    expect(fetched.map(m => [m.seeker[0], m.ciphertext[0]])).toEqual([
      [1, 10],
      [3, 30],
      [2, 20],
      [3, 31],
    ]);
  });

  it('fetches from the reachable transports and fails only when none is', async () => {
    const internet = new DownProtocol();
    const mesh = new DownProtocol();
    const protocol = composite(internet, mesh);
    await expect(protocol.fetchMessages([bytes(1)])).rejects.toThrow();
    expect(protocol.getConnectivity()).toBe('offline');

    mesh.down = false;
    await mesh.sendMessage({ seeker: bytes(1), ciphertext: bytes(5) });
    expect(await protocol.fetchMessages([bytes(1)])).toHaveLength(1);
  });

  it('keeps the bulletin cursor on the primary and drops copies from the others', async () => {
    const internet = new MockMessageProtocol();
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);
    await internet.sendAnnouncement(bytes(1));
    await mesh.sendAnnouncement(bytes(1));
    await mesh.sendAnnouncement(bytes(2));

    const first = await protocol.fetchAnnouncements(10);
    expect(first.map(a => [a.data[0], a.counter])).toEqual([
      [1, '1'],
      [2, undefined],
    ]);

    // the mesh cursor moved on: nothing new comes twice
    expect(await protocol.fetchAnnouncements(10, '1')).toEqual([]);
    await mesh.sendAnnouncement(bytes(3));
    expect(
      (await protocol.fetchAnnouncements(10, '1')).map(a => a.data[0])
    ).toEqual([3]);
  });

  it('returns mesh announcements when the primary is unreachable', async () => {
    const internet = new DownProtocol();
    const mesh = new MockMessageProtocol();
    await mesh.sendAnnouncement(bytes(7));
    const protocol = composite(internet, mesh);
    const items = await protocol.fetchAnnouncements(10, '42');
    expect(items).toEqual([{ data: bytes(7) }]);

    const meshDown = new DownProtocol();
    await expect(
      composite(internet, meshDown).fetchAnnouncements(10)
    ).rejects.toThrow('unreachable');
  });

  it('does not offer back an announcement it sent', async () => {
    const internet = new MockMessageProtocol();
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);
    expect(await protocol.sendAnnouncement(bytes(4))).toBe('1');
    const items = await protocol.fetchAnnouncements(10);
    // the primary copy keeps its counter; the mesh copy is dropped
    expect(items).toEqual([{ counter: '1', data: bytes(4) }]);
  });

  it('reports internet when a transport says so and forwards wanted seekers', async () => {
    const wanted: Uint8Array[][] = [];
    const meshNode: IMessageProtocol = Object.assign(
      new MockMessageProtocol(),
      {
        getConnectivity: (): TransportConnectivity => 'internet',
        setWantedSeekers: async (seekers: Uint8Array[]) => {
          wanted.push(seekers);
        },
      }
    );
    const internet = new DownProtocol();
    const protocol = composite(internet, meshNode);
    await protocol.fetchMessages([bytes(1)]);
    expect(protocol.getConnectivity()).toBe('internet');
    await protocol.setWantedSeekers([bytes(1), bytes(2)]);
    expect(wanted).toEqual([[bytes(1), bytes(2)]]);
  });
  it('keeps mesh-only traffic off the internet transports', async () => {
    const internet = new MockMessageProtocol();
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);
    expect(protocol.isMeshEnabled()).toBe(true);

    await protocol.sendMessage(
      { seeker: bytes(1), ciphertext: bytes(9) },
      { meshOnly: true }
    );
    expect(internet.getStoredMessages().size).toBe(0);
    expect(mesh.getStoredMessages().size).toBe(1);
    expect(protocol.takeAcceptedBy(bytes(1))).toEqual(['mesh']);

    await internet.sendMessage({ seeker: bytes(2), ciphertext: bytes(8) });
    expect(
      await protocol.fetchMessages([bytes(1), bytes(2)], { meshOnly: true })
    ).toEqual([{ seeker: bytes(1), ciphertext: bytes(9) }]);
  });

  it('refuses mesh-only traffic when no mesh is on', async () => {
    const mesh = new MockMessageProtocol() as MockMessageProtocol & {
      isMeshEnabled(): boolean;
    };
    mesh.isMeshEnabled = () => false;
    const protocol = composite(new MockMessageProtocol(), mesh);
    expect(protocol.isMeshEnabled()).toBe(false);
    await expect(
      protocol.sendMessage(
        { seeker: bytes(1), ciphertext: bytes(9) },
        { meshOnly: true }
      )
    ).rejects.toThrow('No mesh transport');
    await expect(
      protocol.fetchMessages([bytes(1)], { meshOnly: true })
    ).rejects.toThrow('No mesh transport');
    expect(mesh.getStoredMessages().size).toBe(0);
  });
});
