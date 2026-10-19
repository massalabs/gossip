import { describe, it, expect } from 'vitest';
import { MeshNodeProtocol } from '../../src/api/messageProtocol/mesh';
import { MockMeshNodePlugin } from '../mocks';
import { encodeToBase64 } from '../../src/utils/base64';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('MeshNodeProtocol', () => {
  it('stores and fetches messages and announcements through the plugin', async () => {
    const plugin = new MockMeshNodePlugin();
    const protocol = new MeshNodeProtocol(plugin);

    await protocol.sendMessage({ seeker: bytes(1, 2), ciphertext: bytes(3) });
    expect(plugin.messages.get(encodeToBase64(bytes(1, 2)))).toEqual([
      encodeToBase64(bytes(3)),
    ]);
    expect(await protocol.fetchMessages([bytes(1, 2), bytes(9)])).toEqual([
      { seeker: bytes(1, 2), ciphertext: bytes(3) },
    ]);

    expect(await protocol.sendAnnouncement(bytes(5))).toBe('1');
    expect(await protocol.fetchAnnouncements(10)).toEqual([
      { counter: '1', data: bytes(5) },
    ]);
    expect(await protocol.fetchAnnouncements(10, '1')).toEqual([]);
    expect(await protocol.fetchBulletinCounter()).toBe('1');
    expect((await protocol.changeNode()).success).toBe(false);
  });

  it('forwards wanted seekers and decodes arrivals', async () => {
    const plugin = new MockMeshNodePlugin();
    const protocol = new MeshNodeProtocol(plugin);
    await protocol.setWantedSeekers([bytes(7)]);
    expect(plugin.wanted).toEqual([encodeToBase64(bytes(7))]);
    expect(plugin.localWanted).toEqual([]);
    await protocol.setWantedSeekers([bytes(7)], [bytes(5)]);
    expect(plugin.localWanted).toEqual([encodeToBase64(bytes(5))]);

    const arrivals: { messages: unknown[]; announcements: Uint8Array[] }[] = [];
    const subscription = await protocol.onArrival(a => arrivals.push(a));
    plugin.emitArrival({
      messages: [
        {
          seeker: encodeToBase64(bytes(7)),
          ciphertext: encodeToBase64(bytes(8)),
        },
      ],
      announcements: [encodeToBase64(bytes(6))],
    });
    await subscription.remove();
    plugin.emitArrival({ messages: [], announcements: [] });
    expect(arrivals).toEqual([
      {
        messages: [{ seeker: bytes(7), ciphertext: bytes(8) }],
        announcements: [bytes(6)],
      },
    ]);
  });

  it('sends mesh-only messages local-only', async () => {
    const plugin = new MockMeshNodePlugin();
    const protocol = new MeshNodeProtocol(plugin);
    await protocol.sendMessage({ seeker: bytes(1), ciphertext: bytes(2) });
    await protocol.sendMessage(
      { seeker: bytes(3), ciphertext: bytes(4) },
      { meshOnly: true }
    );
    expect([...plugin.localOnly]).toEqual([encodeToBase64(bytes(3))]);
  });

  it('derives connectivity from the node status', async () => {
    const plugin = new MockMeshNodePlugin();
    const protocol = new MeshNodeProtocol(plugin);
    expect(protocol.getConnectivity()).toBe('offline');

    await plugin.start();
    plugin.meshPeers = 2;
    await protocol.fetchBulletinCounter(); // reads the status
    expect(protocol.getConnectivity()).toBe('mesh-only');

    plugin.meshPeers = 0;
    plugin.upstreamReachable = true;
    await protocol.fetchBulletinCounter();
    expect(protocol.getConnectivity()).toBe('internet');
  });

  it('reads public keys by hash', async () => {
    const plugin = new MockMeshNodePlugin();
    plugin.keys.set(encodeToBase64(bytes(1)), encodeToBase64(bytes(2, 3)));
    const protocol = new MeshNodeProtocol(plugin);
    expect(await protocol.getKeys(bytes(1))).toEqual(bytes(2, 3));
    expect(await protocol.getKeys(bytes(4))).toBeUndefined();
  });
});
