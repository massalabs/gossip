#!/usr/bin/env npx tsx
/**
 * Utility script to derive a user ID from a mnemonic.
 *
 * Usage:
 *   npx tsx src/get-user-id.ts "your twelve word mnemonic phrase here"
 *
 * Or with environment variable:
 *   npx tsx src/get-user-id.ts
 *   (reads BOT_MNEMONIC from .env)
 */

import 'fake-indexeddb/auto';
import 'dotenv/config';
import { generateUserKeys, encodeUserId } from 'gossip-sdk';

async function main(): Promise<void> {
  // Get mnemonic from command line args or environment
  let mnemonic = process.argv[2];

  if (!mnemonic) {
    mnemonic = process.env.BOT_MNEMONIC;
  }

  if (!mnemonic) {
    console.error('Usage: npx tsx src/get-user-id.ts "your mnemonic phrase"');
    console.error('   or: Set BOT_MNEMONIC in .env file');
    process.exit(1);
  }

  // Clean up mnemonic (remove extra quotes if present)
  mnemonic = mnemonic.replace(/^["']|["']$/g, '').trim();

  console.log('Deriving user ID from mnemonic...\n');

  try {
    // Generate keys from mnemonic
    const userKeys = await generateUserKeys(mnemonic);

    // Derive and encode user ID
    const userIdBytes = userKeys.public_keys().derive_id();
    const userId = encodeUserId(userIdBytes);

    console.log('='.repeat(60));
    console.log('Bot User ID:');
    console.log('='.repeat(60));
    console.log(userId);
    console.log('='.repeat(60));
    console.log('\nShare this ID with users who want to chat with the bot.');
    console.log('They can add it as a contact in the Gossip app.');
  } catch (error) {
    console.error('Error deriving user ID:', error);
    process.exit(1);
  }
}

main();
