/**
 * REST API implementation of the message protocol
 */

import {
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
} from './types';
import { encodeToBase64, decodeFromBase64 } from '../../utils/base64';

const BULLETIN_ENDPOINT = '/bulletin';
const MESSAGES_ENDPOINT = '/messages';

type FetchMessagesResponse = {
  key: string;
  value: string;
};

export class RestMessageProtocol implements IMessageProtocol {
  constructor(
    private baseUrl: string,
    private timeout: number = 10000,
    private retryAttempts: number = 3
  ) {}

  // TODO: Implement a fetch with pagination to avoid fetching all messages at once
  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    const url = `${this.baseUrl}${MESSAGES_ENDPOINT}/fetch`;

    const response = await this.makeRequest<FetchMessagesResponse[]>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seekers: seekers.map(encodeToBase64) }),
    });

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to fetch messages');
    }

    return response.data.map((item: FetchMessagesResponse) => {
      const seeker = decodeFromBase64(item.key);
      const ciphertext = decodeFromBase64(item.value);

      return {
        seeker,
        ciphertext,
      };
    });
  }

  async sendMessage(message: EncryptedMessage): Promise<void> {
    const url = `${this.baseUrl}${MESSAGES_ENDPOINT}/`;

    const response = await this.makeRequest<void>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: encodeToBase64(message.seeker),
        value: encodeToBase64(message.ciphertext),
      }),
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to send message');
    }
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    const url = `${this.baseUrl}${BULLETIN_ENDPOINT}`;

    const response = await this.makeRequest<{ counter: string }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: encodeToBase64(announcement),
      }),
    });

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to broadcast outgoing session');
    }

    return response.data.counter;
  }

  async fetchAnnouncements(): Promise<Uint8Array[]> {
    const url = `${this.baseUrl}${BULLETIN_ENDPOINT}`;

    const response = await this.makeRequest<string[]>(url, {
      method: 'GET',
    });

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to fetch announcements');
    }

    return response.data.map(row => decodeFromBase64(row));
  }

  async fetchPublicKeyByUserId(userId: Uint8Array): Promise<string> {
    const response = await this.makeRequest<{ value: string }>(
      `${this.baseUrl}/auth/retrieve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: encodeToBase64(userId) }),
      }
    );

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to fetch public key');
    }

    return response.data.value;
  }

  async postPublicKey(base64PublicKeys: string): Promise<string> {
    const url = `${this.baseUrl}/auth`;

    const response = await this.makeRequest<{ value: string }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: base64PublicKeys }),
    });

    if (!response.success || !response.data) {
      const errorMessage = response.error || 'Failed to store public key';
      throw new Error(errorMessage);
    }

    return response.data.value;
  }

  private async makeRequest<T>(
    url: string,
    options: RequestInit
  ): Promise<MessageProtocolResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        lastError = error as Error;
        console.warn(`Request attempt ${attempt} failed:`, error);

        if (attempt < this.retryAttempts) {
          // Exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Request failed after all retry attempts',
    };
  }
}
