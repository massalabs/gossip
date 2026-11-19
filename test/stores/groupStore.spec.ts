import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SdkEventType, type GossipSdk } from '@massalabs/gossip-sdk';
import { useSdkStore } from '../../src/stores/sdkStore';
import { useGroupStore } from '../../src/stores/groupStore';
import { makeFakeGroups, summary } from '../helpers/fakeGroups';

describe('groupStore', () => {
  let fake: ReturnType<typeof makeFakeGroups>;

  beforeEach(() => {
    fake = makeFakeGroups();
    fake.state.groups = [
      summary({ groupId: 'g1', name: 'Old' }),
      summary({ groupId: 'g2', name: 'New' }),
    ];
    fake.state.timelines.set('g2', [
      {
        kind: 'message',
        epochId: 'g2',
        syncObjId: 's',
        author: 'bob',
        createdAt: 5,
        lastModifiedAt: 5,
        edited: false,
        body: { type: 'text', text: 'hi' },
        metadata: {},
        replyTo: [],
      },
    ]);
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
  });

  afterEach(() => {
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  it('lists groups with their last message, most recent first', () => {
    useGroupStore.getState().init();
    const { groups, available } = useGroupStore.getState();
    expect(available).toBe(true);
    expect(groups.map(g => g.summary.groupId)).toEqual(['g2', 'g1']);
    expect(groups[0].lastMessage).toEqual({ author: 'bob', text: 'hi', at: 5 });
    expect(groups[1].lastMessage).toBeNull();
  });

  it('marks a group unread on new messages unless it is open', () => {
    useGroupStore.getState().init();
    useGroupStore.getState().setCurrentGroup('g1');
    fake.sdk.emit(SdkEventType.GROUPS_CHANGED, {
      changes: [
        { groupId: 'g1', kind: 'Messages' },
        { groupId: 'g2', kind: 'Messages' },
      ],
    });
    const unread = Object.fromEntries(
      useGroupStore.getState().groups.map(g => [g.summary.groupId, g.unread])
    );
    expect(unread).toEqual({ g1: false, g2: true });
    useGroupStore.getState().markRead('g2');
    expect(useGroupStore.getState().groups.every(g => !g.unread)).toBe(true);
  });

  it('reads invitations again on a change and stops listening on cleanup', () => {
    useGroupStore.getState().init();
    const before = useGroupStore.getState().version;
    fake.state.invitations = [
      {
        epochId: 'e',
        name: 'X',
        members: [],
        owner: 'o',
        receivedFrom: null,
        closedBefore: false,
        rejoins: null,
      },
    ];
    fake.sdk.emit(SdkEventType.GROUPS_CHANGED, {
      changes: [{ groupId: 'e', kind: 'Invitation' }],
    });
    expect(useGroupStore.getState().invitations).toHaveLength(1);
    expect(useGroupStore.getState().version).toBeGreaterThan(before);
    useGroupStore.getState().cleanup();
    expect(fake.sdk.handlers.get(SdkEventType.GROUPS_CHANGED)?.size).toBe(0);
    expect(useGroupStore.getState().groups).toEqual([]);
  });

  it('stays unavailable without the group engine', () => {
    useSdkStore.setState({
      sdk: {
        get groups() {
          throw new Error('Group service not initialized');
        },
      } as unknown as GossipSdk,
    });
    useGroupStore.getState().init();
    expect(useGroupStore.getState().available).toBe(false);
  });
});
