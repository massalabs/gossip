/**
 * Mock Message Protocol Implementation
 *
 * This file contains a mock implementation of the message protocol
 * that simulates backend responses without requiring a real server.
 * Useful for development and testing when the backend is not available.
 */

import { encodeToBase64 } from '../../utils/base64';
import {
  IMessageProtocol,
  EncryptedMessage,
  MessageProtocolResponse,
  PaginatedAnnouncementsResponse,
} from './types';

export class MockMessageProtocol implements IMessageProtocol {
  private mockMessages: Map<string, EncryptedMessage[]> = new Map();
  private mockAnnouncements: Uint8Array[] = [];
  private bulletinCounter = 0;

  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    console.log(
      'Mock: Fetching messages for seekers:',
      seekers.map(s => encodeToBase64(s))
    );

    // For the mock, concatenate messages for all seeker base64 strings
    const collected: EncryptedMessage[] = [];
    for (const seeker of seekers) {
      // Convert seeker to base64 string for storage key
      const key = encodeToBase64(seeker);
      const msgs = this.mockMessages.get(key) || [];
      // attach seeker on returned messages
      collected.push(...msgs.map(m => ({ ...m, seeker })));
    }

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return collected;
  }

  async sendMessage(message: EncryptedMessage): Promise<void> {
    const seekerBase64 = encodeToBase64(message.seeker);
    console.log('Mock: Sending message to seeker (b64):', seekerBase64);

    // Store the message in our mock storage
    if (!this.mockMessages.has(seekerBase64)) {
      this.mockMessages.set(seekerBase64, []);
    }

    const messages = this.mockMessages.get(seekerBase64)!;
    messages.push(message);

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('Mock: Message sent successfully');
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    console.log('Mock: Broadcasting outgoing session announcement');
    this.mockAnnouncements.push(announcement);
    this.bulletinCounter += 1;
    await new Promise(resolve => setTimeout(resolve, 150));
    return String(this.bulletinCounter);
  }

  async fetchAnnouncements(): Promise<Uint8Array[]> {
    console.log('Mock: Fetching announcements');

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 150));

    // Return empty array for now - in a real implementation, this would
    // simulate fetching from a global announcement channel
    return this.mockAnnouncements;
  }

  async fetchAnnouncementsFromCursor(
    cursor?: string,
    limit: number = 100
  ): Promise<PaginatedAnnouncementsResponse> {
    console.log(
      'Mock: Fetching announcements from cursor:',
      cursor,
      'limit:',
      limit
    );

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 150));

    // Parse cursor as starting index (1-based counter)
    // Using BigInt for proper U256 support, but for mock we keep it simple with numbers
    const startIndex = cursor ? parseInt(cursor, 10) - 1 : 0;
    const endIndex = Math.min(
      startIndex + limit,
      this.mockAnnouncements.length
    );
    const slicedAnnouncements = this.mockAnnouncements.slice(
      startIndex,
      endIndex
    );
    const hasMore = endIndex < this.mockAnnouncements.length;
    const nextCursor = hasMore ? String(endIndex + 1) : null;

    // Create items with counter values
    const items = slicedAnnouncements.map((data, index) => ({
      counter: String(startIndex + index + 1), // 1-based counter
      data,
    }));

    return {
      items,
      nextCursor,
      hasMore,
    };
  }

  async fetchBulletinCounter(): Promise<string> {
    console.log('Mock: Fetching bulletin counter');

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 50));

    return String(this.bulletinCounter);
  }

  async fetchPublicKeyByUserId(userId: Uint8Array): Promise<string> {
    console.log(
      'Mock: Fetching public key by userId:',
      encodeToBase64(userId).substring(0, 20) + '...'
    );

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // Mock implementation - return empty base64 string
    // In a real mock, you might want to store and retrieve mock public keys
    throw new Error('Public key not found for this user ID');
  }

  async postPublicKey(_base64PublicKeys: string): Promise<string> {
    console.log('Mock: Posting public key');

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // Return a mock hex key (64 hex chars for 32 bytes)
    return 'a'.repeat(64);
  }

  async changeNode(nodeUrl?: string): Promise<MessageProtocolResponse> {
    return {
      success: true,
      data: nodeUrl || 'https://node.example.com',
    };
  }

  // Helper methods for testing
  addMockMessage(seekerBase64Key: string, message: EncryptedMessage): void {
    if (!this.mockMessages.has(seekerBase64Key)) {
      this.mockMessages.set(seekerBase64Key, []);
    }
    this.mockMessages.get(seekerBase64Key)!.push(message);
  }

  addMockAnnouncement(announcement: Uint8Array): void {
    this.mockAnnouncements.push(announcement);
  }

  clearMockData(): void {
    this.mockMessages.clear();
    this.mockAnnouncements = [];
  }
}
