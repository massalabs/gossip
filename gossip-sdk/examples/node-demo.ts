#!/usr/bin/env npx tsx
/**
 * Gossip SDK — Node.js file-persistence demo
 *
 * Proves the node-fs VFS works end-to-end:
 *   1. Opens SQLite with file-based storage
 *   2. Inserts a contact
 *   3. Closes the database
 *   4. Reopens — reads back the contact (data survived)
 *
 * No network required. Run twice to see data accumulate.
 *
 * Usage:
 *   npx tsx gossip-sdk/examples/node-demo.ts
 */

import * as path from 'node:path';
import * as os from 'node:os';
import {
  initDb,
  closeSqlite,
  insertContact,
  getContactsByOwner,
  type StorageConfig,
} from '../src/db';

const DB_DIR = path.join(os.homedir(), '.gossip-demo', 'db');
const STORAGE: StorageConfig = { type: 'node-fs', path: DB_DIR };
const OWNER = 'demo-owner';

async function main() {
  // ── First open: insert a contact ────────────────────────────────
  console.log('Database directory:', DB_DIR);
  console.log();

  console.log('1) Opening database...');
  await initDb({ storage: STORAGE });

  const before = await getContactsByOwner(OWNER);
  console.log(`   Contacts on disk: ${before.length}`);

  const name = `Alice-${Date.now()}`;
  await insertContact({
    ownerUserId: OWNER,
    userId: `user-${Date.now()}`,
    name,
    publicKeys: new Uint8Array(32),
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  });
  console.log(`   Inserted contact "${name}"`);

  const after = await getContactsByOwner(OWNER);
  console.log(`   Contacts now: ${after.length}`);

  console.log('   Closing database...');
  await closeSqlite();

  // ── Second open: verify persistence ─────────────────────────────
  console.log();
  console.log('2) Reopening database...');
  await initDb({ storage: STORAGE });

  const persisted = await getContactsByOwner(OWNER);
  console.log(`   Contacts after reopen: ${persisted.length}`);

  for (const c of persisted) {
    console.log(`     - ${c.name} (${c.userId})`);
  }

  await closeSqlite();
  console.log();
  console.log('Done. Data persists across opens.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
