/**
 * Auth Protocol — public key publishing & retrieval
 */

import { RestClient } from './restClient';
import { encodeToBase64 } from '../utils/base64';

export interface IAuthProtocol {
  fetchPublicKeyByUserId(userId: Uint8Array): Promise<string>;
  postPublicKey(base64PublicKeys: string): Promise<string>;
}

export class RestAuthProtocol extends RestClient implements IAuthProtocol {
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

    if (!response.data.value) {
      throw new Error('Public key not found');
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
      throw new Error(response.error || 'Failed to store public key');
    }

    return response.data.value;
  }
}
