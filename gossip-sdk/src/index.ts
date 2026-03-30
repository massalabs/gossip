/**
 * Gossip SDK
 *
 * Main entry point for the Gossip SDK.
 * Works in both browser and Node.js environments.
 *
 * WASM is loaded via the web target build with runtime detection:
 * - Browser: init() uses import.meta.url + fetch
 * - Node.js / Jiti: init(bytes) reads the .wasm file from disk
 *
 * @example
 * ```typescript
 * import { gossipSdk } from '@massalabs/gossip-sdk';
 *
 * await gossipSdk.init({ db, protocolBaseUrl: 'https://api.example.com' });
 * await gossipSdk.openSession({ mnemonic: '...' });
 * await gossipSdk.messages.send(contactId, 'Hello!');
 * ```
 *
 * @packageDocumentation
 */

export * from './api/index.js';
export * from './crypto/index.js';
export * from './gossip.js';
export * from './utils/index.js';
export * from './wasm/index.js';
export * from './db/db.js';
export * from './db/queries/index.js';
export * from './db/sqlite.js';
export { SELF_CONTACT_ID } from './services/selfMessage.js';
