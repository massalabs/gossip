/**
 * REST API implementation of the message protocol
 */

import {
  BulletinItem,
  EncryptedMessage,
  MessageRouting,
  IMessageProtocol,
  MessageProtocolResponse,
} from './types.js';
import { RestClient } from '../restClient.js';
import { encodeToBase64, decodeFromBase64 } from '../../utils/base64.js';

const BULLETIN_ENDPOINT = '/bulletin';
const MESSAGES_ENDPOINT = '/messages';

export type BulletinsPage = {
  counter: string;
  data: string;
}[];

type FetchMessagesResponse = {
  key: string;
  value: string;
};

/** An internet node must never see traffic meant for the mesh only. */
function refuseMeshOnly(routing?: MessageRouting): void {
  if (routing?.meshOnly) {
    throw new Error('The REST node does not take mesh-only traffic');
  }
}

export class RestMessageProtocol
  extends RestClient
  implements IMessageProtocol
{
  // TODO: Implement a fetch with pagination to avoid fetching all messages at once
  async fetchMessages(
    seekers: Uint8Array[],
    routing?: MessageRouting
  ): Promise<EncryptedMessage[]> {
    refuseMeshOnly(routing);
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

  async sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void> {
    refuseMeshOnly(routing);
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

  async fetchAnnouncements(
    limit: number = 50,
    cursor?: string
  ): Promise<BulletinItem[]> {
    const params = new URLSearchParams();

    params.set('limit', limit.toString());
    // Always pass 'after' parameter. If cursor is undefined, use '0' to fetch from the beginning.
    // This ensures pagination works correctly: after=0 gets counters 1-20, after=20 gets 21-40, etc.
    params.set('after', cursor ?? '0');

    const url = `${this.baseUrl}${BULLETIN_ENDPOINT}?${params.toString()}`;

    const response = await this.makeRequest<BulletinsPage>(url, {
      method: 'GET',
    });

    if (!response.success || response.data == null) {
      throw new Error(response.error || 'Failed to fetch announcements');
    }

    return response.data.map(item => ({
      counter: item.counter,
      data: decodeFromBase64(item.data),
    }));
  }

  async fetchBulletinCounter(): Promise<string> {
    const url = `${this.baseUrl}${BULLETIN_ENDPOINT}/counter`;

    const response = await this.makeRequest<{ counter: string }>(url, {
      method: 'GET',
    });

    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to fetch bulletin counter');
    }

    return response.data.counter;
  }

  async changeNode(nodeUrl?: string): Promise<MessageProtocolResponse> {
    return {
      success: true,
      data:
        'This message protocol provider use a single node, so changing the node to ' +
        nodeUrl +
        ' is not supported',
    };
  }
}
