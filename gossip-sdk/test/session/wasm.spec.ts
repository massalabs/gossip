/**
 * Real WASM Session Tests
 *
 * These tests use the actual WASM SessionModule with real crypto.
 * No mocks - tests actual session establishment and message encryption.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SessionStatus } from '../../src/wasm/bindings';
import {
  createTestSession,
  createTestSessionPair,
  cleanupTestSession,
  TestSessionData,
} from '../utils';

describe('Real WASM Session', () => {
  const sessionsToCleanup: TestSessionData[] = [];

  afterEach(() => {
    // Cleanup all sessions created during tests
    sessionsToCleanup.forEach(cleanupTestSession);
    sessionsToCleanup.length = 0;
  });

  it('should create a session with real WASM keys', async () => {
    const sessionData = await createTestSession();
    sessionsToCleanup.push(sessionData);

    expect(sessionData.session.userId).toBeInstanceOf(Uint8Array);
    expect(sessionData.session.userId.length).toBe(32);
    expect(sessionData.session.userIdEncoded).toMatch(/^gossip1/);
  });

  it('should establish outgoing session between Alice and Bob', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Alice establishes outgoing session to Bob
    const announcement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );

    expect(announcement).toBeInstanceOf(Uint8Array);
    expect(announcement.length).toBeGreaterThan(0);

    // Alice should now have Bob as a peer with SelfRequested status
    const alicePeers = alice.session.peerList();
    expect(alicePeers.length).toBe(1);

    const bobStatus = alice.session.peerSessionStatus(bob.session.userId);
    expect(bobStatus).toBe(SessionStatus.SelfRequested);
  });

  it('should complete full session handshake', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Alice creates announcement for Bob
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );

    // Bob receives and processes Alice's announcement
    const announcementResult =
      await bob.session.feedIncomingAnnouncement(aliceAnnouncement);

    expect(announcementResult).toBeDefined();
    expect(announcementResult?.announcer_public_keys).toBeDefined();

    // Bob should now have Alice as a peer with PeerRequested status
    const aliceStatusFromBob = bob.session.peerSessionStatus(
      alice.session.userId
    );
    expect(aliceStatusFromBob).toBe(SessionStatus.PeerRequested);

    // Bob accepts by establishing outgoing session to Alice
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );

    // Alice receives Bob's acceptance announcement
    const bobAnnouncementResult =
      await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    expect(bobAnnouncementResult).toBeDefined();

    // Both should now have Active sessions
    const aliceStatusOfBob = alice.session.peerSessionStatus(
      bob.session.userId
    );
    const bobStatusOfAlice = bob.session.peerSessionStatus(
      alice.session.userId
    );

    expect(aliceStatusOfBob).toBe(SessionStatus.Active);
    expect(bobStatusOfAlice).toBe(SessionStatus.Active);
  });

  it('should include user data in announcement', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Alice sends announcement with custom user data
    const userData = new TextEncoder().encode(
      JSON.stringify({ u: 'Alice', m: 'Hello!' })
    );
    const announcement = await alice.session.establishOutgoingSession(
      bob.session.ourPk,
      userData
    );

    // Bob processes and extracts user data
    const result = await bob.session.feedIncomingAnnouncement(announcement);

    expect(result).toBeDefined();
    expect(result?.user_data).toBeInstanceOf(Uint8Array);

    const parsedUserData = JSON.parse(
      new TextDecoder().decode(result?.user_data)
    );
    expect(parsedUserData.u).toBe('Alice');
    expect(parsedUserData.m).toBe('Hello!');
  });

  it('should get message board read keys (seekers)', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);

    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    // Both should have seekers to monitor
    const aliceSeekers = alice.session.getMessageBoardReadKeys();
    const bobSeekers = bob.session.getMessageBoardReadKeys();

    expect(aliceSeekers.length).toBeGreaterThan(0);
    expect(bobSeekers.length).toBeGreaterThan(0);

    // Each seeker should be a valid key
    aliceSeekers.forEach(seeker => {
      expect(seeker).toBeInstanceOf(Uint8Array);
      expect(seeker.length).toBeGreaterThan(0);
    });
  });

  it('should send and receive encrypted messages', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Establish session (Alice initiates, Bob accepts)
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);

    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    // Both sessions should be active
    expect(alice.session.peerSessionStatus(bob.session.userId)).toBe(
      SessionStatus.Active
    );
    expect(bob.session.peerSessionStatus(alice.session.userId)).toBe(
      SessionStatus.Active
    );

    // Alice sends a message to Bob
    const messageContent = new TextEncoder().encode('Hello Bob!');
    const sendResult = await alice.session.sendMessage(
      bob.session.userId,
      messageContent
    );

    expect(sendResult).toBeDefined();
    expect(sendResult?.seeker).toBeInstanceOf(Uint8Array);
    expect(sendResult?.data).toBeInstanceOf(Uint8Array);

    // Bob receives and decrypts the message
    const receiveResult = await bob.session.feedIncomingMessageBoardRead(
      sendResult!.seeker,
      sendResult!.data
    );

    expect(receiveResult).toBeDefined();

    // The plaintext should contain the original message
    if (receiveResult?.plaintext) {
      const decryptedMessage = new TextDecoder().decode(
        receiveResult.plaintext
      );
      expect(decryptedMessage).toBe('Hello Bob!');
    }
  });

  it('should discard peer session', async () => {
    const { alice, bob } = await createTestSessionPair();
    sessionsToCleanup.push(alice, bob);

    // Alice establishes session
    await alice.session.establishOutgoingSession(bob.session.ourPk);

    expect(alice.session.peerList().length).toBe(1);

    // Alice discards Bob
    await alice.session.peerDiscard(bob.session.userId);

    // Bob should no longer be in peer list (or status should be Killed)
    const statusAfterDiscard = alice.session.peerSessionStatus(
      bob.session.userId
    );
    expect(
      statusAfterDiscard === SessionStatus.Killed ||
        statusAfterDiscard === SessionStatus.UnknownPeer
    ).toBe(true);
  });
});
