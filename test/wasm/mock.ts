/**
 * Mock Session Module for Testing
 *
 * This file provides Vitest mocks for SessionModule and related WASM types.
 */

import { vi } from 'vitest';
import {
  UserPublicKeys,
  UserSecretKeys,
  SessionStatus,
  AnnouncementResult,
  SendMessageOutput,
  ReceiveMessageOutput,
  EncryptionKey,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { UserProfile } from '../../src/db';

/**
 * Mock SessionModule class
 *
 * This class implements the same interface as SessionModule to allow
 * it to be used as a drop-in replacement in tests without type casts.
 */
export class MockSessionModule {
  // Properties matching SessionModule's public interface exactly
  public ourPk: UserPublicKeys;
  public ourSk: UserSecretKeys;
  public userId: Uint8Array;
  public userIdEncoded: string;

  // Private properties matching SessionModule exactly
  // Note: TypeScript doesn't allow assigning classes with private properties of the same name
  // This is a known limitation. The mock will work at runtime but requires type handling.
  private sessionManager: unknown | null = null;
  private onPersist?: () => void;

  // Methods matching SessionModule's public interface exactly
  // Using vi.fn() to allow mocking in tests
  setOnPersist = vi.fn<(callback: () => void) => void>();
  load = vi.fn<(profile: UserProfile, encryptionKey: EncryptionKey) => void>();
  toEncryptedBlob = vi.fn<(key: EncryptionKey) => Uint8Array>(
    () => new Uint8Array(100)
  );
  cleanup = vi.fn<() => void>();
  establishOutgoingSession = vi.fn<
    (peerPk: UserPublicKeys, userData?: Uint8Array) => Uint8Array
  >(() => new Uint8Array(200));
  feedIncomingAnnouncement = vi.fn<
    (announcementBytes: Uint8Array) => AnnouncementResult | undefined
  >(() => undefined);
  getMessageBoardReadKeys = vi.fn<() => Array<Uint8Array>>(() => []);
  feedIncomingMessageBoardRead = vi.fn<
    (
      seeker: Uint8Array,
      ciphertext: Uint8Array
    ) => ReceiveMessageOutput | undefined
  >(() => undefined);
  sendMessage = vi.fn<
    (peerId: Uint8Array, message: Uint8Array) => SendMessageOutput | undefined
  >(() => {
    const seeker = new Uint8Array(32);
    const data = new Uint8Array(100);
    crypto.getRandomValues(seeker);
    crypto.getRandomValues(data);
    return { seeker, data } as SendMessageOutput;
  });
  peerList = vi.fn<() => Array<Uint8Array>>(() => []);
  peerSessionStatus = vi.fn<(peerId: Uint8Array) => SessionStatus>(() => 2); // NoSession
  peerDiscard = vi.fn<(peerId: Uint8Array) => void>();
  refresh = vi.fn<() => Array<Uint8Array>>(() => []);

  // Private method matching SessionModule
  private persistIfNeeded = vi.fn<() => void>();

  constructor(publicKeys: UserPublicKeys, secretKeys: UserSecretKeys) {
    this.ourPk = publicKeys;
    this.ourSk = secretKeys;
    this.userId = this.ourPk.derive_id();
    this.userIdEncoded = '';
  }
}
