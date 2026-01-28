# Storage Abstraction Layer

## Overview

The storage layer provides a unified API for data persistence across different environments with optional encryption and plausible deniability.

## Quick Start

```typescript
import { StorageManager } from './storage';

// Auto-detect best backend for current environment
const storage = await StorageManager.create({ type: 'auto' });

// Use repositories
const contacts = await storage.contacts.getByOwner(userId);
await storage.messages.create({ ... });
```

## Backend Options

| Backend            | Environment       | Encryption     | Plausible Deniability | Performance |
| ------------------ | ----------------- | -------------- | --------------------- | ----------- |
| `dexie`            | Browser only      | ❌             | ❌                    | Fast        |
| `encrypted-sqlite` | Browser + Node.js | ✅ AES-256-SIV | ✅                    | Medium      |
| `node`             | Node.js only      | ❌             | ❌                    | Fast        |

## Usage by Environment

### Frontend (Browser) - No Encryption

Best for: Development, non-sensitive data

```typescript
import { StorageManager } from './storage';

const storage = await StorageManager.create({
  type: 'dexie',
});

// Data stored in IndexedDB (browser storage)
// Readable if someone inspects browser storage
```

### Frontend (Browser) - With Encryption + Plausible Deniability

Best for: Production, sensitive data, privacy-focused apps

```typescript
import { StorageManager } from './storage';

const storage = await StorageManager.create({
  type: 'encrypted-sqlite',
});

// First time: create session with password
await storage.createSession('user-password');

// After app restart: unlock existing session
const success = await storage.unlock('user-password');
if (!success) {
  console.error('Invalid password');
}

// Lock when user logs out or app goes to background
await storage.lock();
```

**How it works:**

- Data encrypted with AES-256-SIV
- Stored in OPFS (Origin Private File System)
- 2MB addressing blob with 65,536 random-looking slots
- Each password unlocks different data (plausible deniability)
- Runs in Web Worker (non-blocking UI)

### Backend (Node.js) - With Encryption + Plausible Deniability

Best for: Self-hosted servers, privacy-focused backends

```typescript
import { StorageManager } from './storage';

const storage = await StorageManager.create({
  type: 'encrypted-sqlite',
  storagePath: './data', // Where to store encrypted files
});

await storage.createSession('server-password');

// Files created:
// ./data/addressing.bin (2MB, random noise with encrypted pointers)
// ./data/data.bin (variable size, encrypted SQLite pages)
```

**Same security as browser:**

- Same Rust WASM crypto module
- Same file format (addressing.bin + data.bin)
- Same plausible deniability

### Backend (Node.js) - No Encryption (Faster)

Best for: Trusted servers, maximum performance, simpler setup

```typescript
import { StorageManager } from './storage';

const storage = await StorageManager.create({
  type: 'node',
  encrypted: false,
  dbPath: './data',
});

// No password needed
// Data stored in plain SQLite file: ./data/gossip.db
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      YOUR APPLICATION                           │
│                            │                                    │
│                    StorageManager.create()                      │
│                            │                                    │
│              ┌─────────────┼─────────────┐                     │
│              ▼             ▼             ▼                      │
│        ┌─────────┐   ┌──────────┐   ┌─────────┐                │
│        │  Dexie  │   │ Encrypted│   │  Node   │                │
│        │ Backend │   │  SQLite  │   │ Backend │                │
│        └────┬────┘   └────┬─────┘   └────┬────┘                │
│             │             │              │                      │
│             ▼             ▼              ▼                      │
│        IndexedDB    WASM + OPFS/fs   SQLite file               │
│        (browser)    (browser/node)   (node only)               │
└─────────────────────────────────────────────────────────────────┘
```

## Repository API

All backends expose the same repository interface:

```typescript
// Contacts
storage.contacts.get(id)
storage.contacts.getByOwner(userId)
storage.contacts.create({ ownerUserId, userId, username, ... })
storage.contacts.update(id, { username: 'new' })
storage.contacts.delete(id)
storage.contacts.observeByOwner(userId)  // Reactive updates

// Messages
storage.messages.getByContact(ownerUserId, contactUserId)
storage.messages.create({ ... })
storage.messages.observeByContact(ownerUserId, contactUserId)

// Discussions
storage.discussions.getByOwner(userId)
storage.discussions.observeByOwner(userId)

// User Profile
storage.userProfile.getByUserId(userId)
storage.userProfile.observeByUserId(userId)
```

## Plausible Deniability Explained

With encrypted-sqlite backend, different passwords reveal different data:

```
Password "work123"     →  Unlocks work contacts & messages
Password "personal456" →  Unlocks personal contacts & messages
Password "decoy789"    →  Unlocks decoy data (fake contacts)
```

**Key properties:**

- An attacker cannot prove other passwords/data exist
- All 65,536 slots in addressing.bin look like random noise
- Only correct password can find the 46 slots for that session
- Constant-time scanning prevents timing attacks

## Session Lifecycle

```
┌─────────┐     createSession()     ┌──────────┐
│ LOCKED  │ ──────────────────────► │ UNLOCKED │
│         │ ◄────────────────────── │          │
└─────────┘        lock()           └──────────┘
     │                                    │
     │         unlockSession()            │
     └────────────────────────────────────┘
```

```typescript
// Check session state
if (storage.isLocked()) {
  // Show password prompt
  const success = await storage.unlock(password);
}

// Lock on app background/logout
await storage.lock();
```

## File Structure (Encrypted Backend)

```
./data/
├── addressing.bin   # 2MB fixed size, looks like random noise
│                    # Contains 65,536 × 32-byte slots
│                    # Each session uses 46 pseudo-random slots
│
└── data.bin         # Variable size, encrypted SQLite pages
                     # Multiple sessions can coexist at different offsets
```

## Choosing the Right Backend

| Use Case                       | Recommended Backend           |
| ------------------------------ | ----------------------------- |
| Development/testing            | `dexie` (fastest, no setup)   |
| Production web app (sensitive) | `encrypted-sqlite`            |
| Production mobile app          | `encrypted-sqlite`            |
| Trusted backend server         | `node` (encrypted: false)     |
| Self-hosted/privacy backend    | `encrypted-sqlite`            |
| Maximum security               | `encrypted-sqlite` everywhere |

## Security Notes

### Encrypted Backend

- Keys derived with Argon2id (memory-hard, GPU-resistant)
- Data encrypted with AES-256-SIV (misuse-resistant)
- Keys never leave WASM memory (not accessible from JS)
- Constant-time slot scanning (no timing leaks)

### Dexie Backend

- Data stored in plain IndexedDB
- Readable via browser DevTools
- No encryption at rest
- Fast and simple

### Node Backend (unencrypted)

- Plain SQLite file on disk
- Readable by anyone with file access
- Use OS-level encryption (LUKS, FileVault) if needed
