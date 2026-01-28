/**
 * Protocol config tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  protocolConfig,
  setProtocolBaseUrl,
  resetProtocolBaseUrl,
} from '../../src/config/protocol';

describe('protocol config', () => {
  beforeEach(() => {
    resetProtocolBaseUrl();
  });

  afterEach(() => {
    resetProtocolBaseUrl();
  });

  it('uses runtime override when provided', () => {
    setProtocolBaseUrl('https://custom.example.com/api');
    expect(protocolConfig.baseUrl).toBe('https://custom.example.com/api');
  });

  it('resets to default after override', () => {
    setProtocolBaseUrl('https://custom.example.com/api');
    resetProtocolBaseUrl();
    expect(protocolConfig.baseUrl).toBe('https://api.usegossip.com/api');
  });
});
