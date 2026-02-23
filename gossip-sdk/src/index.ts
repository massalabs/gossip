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

export * from './api';
export * from './crypto';
export * from './gossip';
export * from './utils';
export * from './wasm';
export * from './db/db';
export * from './db/queries';
export * from './db/sqlite';
