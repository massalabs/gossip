import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GroupMessage,
  GroupRadioReceived,
  GroupRadioRelay,
} from '@massalabs/gossip-sdk';
import {
  FRESH_MS,
  RadioForwarder,
  relayRef,
} from '../../src/services/radioForwarder';

/**
 * The relay rules against a fake group service: demand, the author's
 * override, freshness, order, and giving up when someone else relayed.
 */

const ME = 'gossip1me';
const ALICE = 'gossip1alice';
const CAROL = 'gossip1carol';
const GROUP = 'g'.repeat(64);

let clock = 1_800_000_000_000;
let serial = 0;

function message(
  over: Partial<GroupMessage> & { text?: string; radio?: number } = {}
): GroupMessage {
  serial += 1;
  const { text = `message ${serial}`, radio, ...rest } = over;
  return {
    kind: 'message',
    epochId: 'e'.repeat(64),
    syncObjId: serial.toString(16).padStart(16, '0').padEnd(64, 'a'),
    author: ALICE,
    createdAt: BigInt(clock),
    lastModifiedAt: BigInt(clock),
    edited: false,
    body: { type: 'text', text },
    metadata: radio === undefined ? {} : { radio: Uint8Array.of(radio) },
    replyTo: [],
    reactions: [],
    ...rest,
  } as GroupMessage;
}

function heardFrom(author: string, syncObjId = 'f'.repeat(64)) {
  return {
    kind: 'message',
    epochId: 'e'.repeat(64),
    groupId: GROUP,
    eventId: 'x',
    syncObjId,
    author,
    olderKey: false,
    accepted: true,
  } as GroupRadioReceived;
}

describe('RadioForwarder', () => {
  let timeline: GroupMessage[];
  let sent: { text: string; zeroHop: boolean }[];
  let members: number;
  let f: RadioForwarder;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    timeline = [];
    sent = [];
    members = 10;
    f = new RadioForwarder({
      me: ME,
      memberCount: () => members,
      groups: {
        timeline: async () => timeline,
        radioRecords: async () => new Map(),
        sealRadioRelay: async (m: GroupMessage) =>
          new TextEncoder().encode(m.body.type === 'text' ? m.body.text : ''),
      } as never,
      send: async (d, zeroHop) => {
        sent.push({ text: new TextDecoder().decode(d), zeroHop });
      },
      now: () => Date.now(),
      random: () => 0,
    });
    // Messages written before the radio was connected are never relayed.
    clock += 1_000;
    vi.setSystemTime(clock);
  });

  afterEach(() => {
    f.stop();
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTimeAsync(30_000);

  it('relays nothing while no member is heard by radio only', async () => {
    timeline = [message()];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent).toEqual([]);
  });

  it('relays for a member heard by radio only, zero-hop when heard directly', async () => {
    f.heardOnRadio(heardFrom(CAROL), 8, 0);
    timeline = [message({ text: 'for carol' })];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent).toEqual([{ text: 'for carol', zeroHop: true }]);

    // Once: the same message is not relayed again.
    await f.groupChanged(GROUP);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("relays this account's own message first", async () => {
    f.heardOnRadio(heardFrom(CAROL), -20, 0);
    timeline = [message({ author: ME, text: 'mine' })];
    await f.groupChanged(GROUP);
    await vi.advanceTimersByTimeAsync(400);
    expect(sent.map(s => s.text)).toEqual(['mine']);
  });

  it('floods when a radio-only member was heard through repeaters', async () => {
    f.heardOnRadio(heardFrom(CAROL), 2, 3);
    timeline = [message()];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent.map(s => s.zeroHop)).toEqual([false]);
  });

  it("follows the author's override: never for none, always for priority", async () => {
    timeline = [message({ text: 'priority', radio: 1 })];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent.map(s => s.text)).toEqual(['priority']);

    f.heardOnRadio(heardFrom(CAROL), 8, 0);
    timeline = [...timeline, message({ text: 'not by radio', radio: 2 })];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent.map(s => s.text)).toEqual(['priority']);
  });

  it('gives up when the relay is heard from another member first', async () => {
    f.heardOnRadio(heardFrom(CAROL), -5, 0);
    const m = message();
    timeline = [m];
    await f.groupChanged(GROUP);
    expect(f.queued).toEqual([relayRef(m.syncObjId)]);
    f.heardOnRadio(
      { kind: 'relay', syncRef: relayRef(m.syncObjId) } as GroupRadioRelay,
      0,
      0
    );
    await settle();
    expect(sent).toEqual([]);
  });

  it('leaves out old messages and the messages of radio-only members themselves', async () => {
    f.heardOnRadio(heardFrom(CAROL), 8, 0);
    clock += FRESH_MS + 5_000;
    vi.setSystemTime(clock);
    timeline = [
      message({ createdAt: BigInt(clock - FRESH_MS - 1) }),
      message({ author: CAROL }),
    ];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent).toEqual([]);
  });

  it('sends priority first, then replies to a radio-only member, then the rest', async () => {
    f.heardOnRadio(heardFrom(CAROL), -20, 2);
    const carols = message({ author: CAROL, text: 'from carol' });
    timeline = [
      message({ text: 'plain' }),
      message({
        text: 'reply to carol',
        replyTo: [
          { epochId: null, syncObjId: carols.syncObjId, message: carols },
        ],
      }),
      message({ text: 'priority', radio: 1 }),
    ];
    await f.groupChanged(GROUP);
    await settle();
    expect(sent.map(s => s.text)).toEqual([
      'priority',
      'reply to carol',
      'plain',
    ]);
  });
});
