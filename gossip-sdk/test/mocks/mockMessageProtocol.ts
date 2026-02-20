/**
 * In-Memory Mock Message Protocol for Testing
 *
 * This mock stores messages and announcements in memory,
 * allowing tests to verify messaging flows without network calls.
 */

import type {
  IMessageProtocol,
  EncryptedMessage,
  BulletinItem,
} from '../../src/api/messageProtocol/types';

export class MockMessageProtocol implements IMessageProtocol {
  private messages: Map<string, Uint8Array> = new Map();
  private announcements: BulletinItem[] = [];
  private announcementCounter = 0;

  constructor(
    public baseUrl: string = 'mock://test',
    public timeout: number = 10000,
    public retryAttempts: number = 3
  ) {}

  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    const results: EncryptedMessage[] = [];
    for (const seeker of seekers) {
      const key = this.uint8ArrayToKey(seeker);
      const ciphertext = this.messages.get(key);
      if (ciphertext) {
        results.push({ seeker, ciphertext });
      }
    }
    return results;
  }

  async sendMessage(message: EncryptedMessage): Promise<void> {
    const key = this.uint8ArrayToKey(message.seeker);
    this.messages.set(key, message.ciphertext);
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    const counter = String(++this.announcementCounter);
    this.announcements.push({ counter, data: announcement });
    return counter;
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    let results = [...this.announcements];

    // Filter by cursor (return only announcements after this counter)
    if (cursor) {
      const cursorNum = parseInt(cursor, 10);
      results = results.filter(a => parseInt(a.counter, 10) > cursorNum);
    }

    // Apply limit
    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }

    return results;
  }

  async fetchBulletinCounter(): Promise<string> {
    return String(this.announcementCounter);
  }

  async changeNode(newBaseUrl: string): Promise<{ success: boolean }> {
    this.baseUrl = newBaseUrl;
    return { success: true };
  }

  // Test helper methods
  clearMockData(): void {
    this.messages.clear();
    this.announcements = [];
    this.announcementCounter = 0;
  }

  getStoredMessages(): Map<string, Uint8Array> {
    return new Map(this.messages);
  }

  getStoredAnnouncements(): BulletinItem[] {
    return [...this.announcements];
  }

  private uint8ArrayToKey(arr: Uint8Array): string {
    return Array.from(arr).join(',');
  }
}
