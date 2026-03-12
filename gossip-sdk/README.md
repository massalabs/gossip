# Gossip SDK

A platform-agnostic SDK for the Gossip messenger app. Enables automation, chatbot integrations, and programmatic access to Gossip functionality.

## Overview

The Gossip SDK provides a clean, typed interface for:

- **Contact Management** - Add, update, and delete contacts
- **Discussion Management** - Initialize and manage encrypted discussions
- **Message Operations** - Send and receive encrypted messages
- **Announcement Handling** - Process protocol announcements
- **Session Management** - Automatic session renewal and persistence

## Installation

```bash
npm install @massalabs/gossip-sdk
```

## Quick Start

The SDK exposes a convenient singleton `gossipSdk` for most apps, and you can also create additional `GossipSdk` instances when you need multiple independent sessions:

```typescript
import { gossipSdk, GossipSdk, SdkEventType } from '@massalabs/gossip-sdk';

// Use the singleton for most cases
const sdk = gossipSdk;

// Or create your own instance if you need multiple SDKs in the same process
// const sdk = await new GossipSdk().init({
//   storage: { type: 'idb', name: 'gossip-db' },
// });

// 1. Initialize (optional config)
await sdk.init({
  // protocolBaseUrl: 'https://api.usegossip.com', // optional, otherwise env/default is used
  // storage: { type: 'idb', name: 'gossip-db' }, // optional, defaults to in-memory
});

// 2. Open session (login)
await sdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  // Optional: for existing session
  // encryptedSession: savedBlob,
  // encryptionKey,  // optional - derived from mnemonic if not provided
  // Optional: for persistence
  // onPersist: async (blob, key) => { await saveToStorage(blob, key); },
});

// 3. Use the SDK
const contacts = await sdk.contacts.list();
await sdk.discussions.startByUserId(contactUserId, 'Alice', {
  username: 'Alice',
  message: 'Hello!',
});
await sdk.messages.sendText(contactUserId, 'Hi Alice!');

// 4. Listen to events
sdk.on(SdkEventType.MESSAGE_RECEIVED, msg => {
  console.log('New message:', msg);
});

// 5. Logout
await sdk.closeSession();
```

## Lifecycle

### 1. Initialize

Call `init()` once at app startup on your SDK instance (either the `gossipSdk` singleton or an instance of `GossipSdk`). All options inside the `GossipSdkInitOptions` object are optional:

```typescript
// Uses VITE_GOSSIP_API_URL / GOSSIP_API_URL env vars, or defaults to https://api.usegossip.com/api
await sdk.init({});

// Or with explicit config
await sdk.init({
  protocolBaseUrl: 'https://api.usegossip.com/api',
  config: {
    polling: {
      enabled: true,
      messagesIntervalMs: 3000,
    },
  },
});
```

### 2. Open Session (Login)

Call `openSession()` to authenticate and create a cryptographic session:

```typescript
// New account (no existing session)
await sdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
});

// Restore existing session
await sdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  encryptedSession: savedBlob,
  encryptionKey: savedKey,
});

// With persistence (saves session on changes)
await sdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  encryptionKey,
  onPersist: async (blob, key) => {
    await storage.save({ session: blob });
  },
});
```

### 3. Close Session (Logout)

```typescript
await sdk.closeSession();
```

## Service APIs

All services are available after `openSession()` is called.

### Messages

```typescript
// Send a message
const result = await sdk.messages.send({
  ownerUserId: sdk.userId, // inferred session owner
  contactUserId: contactId, // encoded userId of the contact
  content: 'Hello!',
  type: MessageType.TEXT,
  direction: MessageDirection.OUTGOING,
  status: MessageStatus.WAITING_SESSION,
  timestamp: new Date(),
});

// Or use the simplified helper
await sdk.messages.sendText(contactId, 'Hello!', {
  metadata: { source: 'bot' },
});

// Fetch new messages from server
const fetchResult = await sdk.messages.fetch();

// Get all messages for a given contact (raw, protocol-level view)
const messages = await sdk.messages.getMessages(contactId);

// Get only user-visible messages for a contact
// - Excludes KEEP_ALIVE protocol pings
// - Excludes outgoing delete control messages (empty content)
// - Ordered by ascending database id
const visibleMessages = await sdk.messages.getVisibleMessages(contactId);

// Mark a specific message (by DB ID) as read
await sdk.messages.markAsRead(messageId);
```

### Discussions

```typescript
// Start a new discussion
const result = await sdk.discussions.startByUserId(contactUserId, 'Alice', {
  username: 'Alice',
  message: 'Hi!',
});

// Accept an incoming discussion request
await sdk.discussions.accept(discussion);

// Renew a broken session
await sdk.discussions.renew(contactUserId);

// Get session status for a contact
const status = sdk.discussions.getStatus(contactUserId);

// List all discussions
const discussions = await sdk.discussions.list();

// Get a specific discussion
const discussion = await sdk.discussions.get(contactUserId);
```

### Contacts

```typescript
// List all contacts
const contacts = await sdk.contacts.list();

// Get a specific contact
const contact = await sdk.contacts.get(contactUserId);

// Add a new contact
const result = await sdk.contacts.add(contactUserId, 'Alice', publicKeys);

// Update contact name
await sdk.contacts.updateName(contactUserId, 'Alice Smith');

// Delete contact and all associated data
await sdk.contacts.delete(contactUserId);
```

### Announcements

```typescript
// Fetch and process announcements from server
const result = await sdk.announcements.fetch();
```

### Auth (Available after init, before session)

```typescript
// Publish public key so the user is discoverable
await sdk.auth.publishPublicKey(publicKey);
```

## Events

Subscribe to SDK events using `SdkEventType`:

```typescript
import { SdkEventType } from '@massalabs/gossip-sdk';

// Message events
sdk.on(SdkEventType.MESSAGE_RECEIVED, message => { ... });
sdk.on(SdkEventType.MESSAGE_SENT, message => { ... });

// Discussion events
sdk.on(SdkEventType.SESSION_REQUESTED, (discussion, contact) => { ... });

// Error handling
sdk.on(SdkEventType.ERROR, (error, context) => {
  console.error(`Error in ${context}:`, error);
});

// Unsubscribe
sdk.off(SdkEventType.MESSAGE_RECEIVED, handler);
```

## Polling

```typescript
// Enable via config
await sdk.init({
  config: {
    polling: {
      enabled: true,
      messagesIntervalMs: 5000,
      announcementsIntervalMs: 10000,
      sessionRefreshIntervalMs: 30000,
    },
  },
});

// Or control manually
sdk.polling.start();
sdk.polling.stop();
console.log(sdk.polling.isRunning);
```

## Session Info

```typescript
const userId = sdk.userId; // Encoded string
const userIdBytes = sdk.userIdBytes; // Raw bytes
const publicKeys = sdk.publicKeys;

console.log(sdk.isInitialized); // true after init()
console.log(sdk.isSessionOpen); // true after openSession()

// Get encrypted session for manual persistence
const blob = sdk.getEncryptedSession();
```

## State Update

Trigger a full state refresh for all discussions (session renewal, queued messages, keep-alives):

```typescript
await sdk.updateState();
```

## Utilities

```typescript
const utils = sdk.utils;

// Validate user ID format
const result = utils.validateUserId(userId);
if (!result.valid) console.error(result.error);

// Validate username format
const result = utils.validateUsername(username);

// Encode/decode user IDs
const encoded = utils.encodeUserId(rawBytes);
const decoded = utils.decodeUserId(encodedString);
```

## Configuration

Full configuration options with defaults:

```typescript
await sdk.init({
  config: {
    protocol: {
      baseUrl: 'https://api.usegossip.com', // optional; if omitted, env/default is used
      timeout: 10000,
      retryAttempts: 3,
    },
    polling: {
      enabled: false,
      messagesIntervalMs: 5000,
      announcementsIntervalMs: 10000,
      sessionRefreshIntervalMs: 10000,
    },
    messages: {
      fetchDelayMs: 100,
      maxFetchIterations: 30,
      deduplicationWindowMs: 30000,
      retryDelayMs: 5000,
    },
    announcements: {
      fetchLimit: 500,
      brokenThresholdMs: 60 * 60 * 1000,
      retryDelayMs: 15000,
    },
    sessionRecovery: {
      killedRetryDelayMs: 15 * 60 * 1000,
      JitterMs: 2 * 60 * 1000,
      saturatedRetryDelayMs: 5 * 60 * 1000,
    },
  },
});
```

## Session Persistence

For restoring sessions across app restarts, pass `encryptionKey` (optional — derived from mnemonic if omitted) and `onPersist` when opening the session:

```typescript
await sdk.openSession({
  mnemonic,
  encryptionKey, // optional
  onPersist: async (blob, key) => {
    await storage.save({ session: blob });
  },
});
```

## Auto-Renewal Behavior

The SDK automatically handles session recovery:

1. **Session Lost** - When a session is killed/lost, messages are queued as `WAITING_SESSION`
2. **Auto-Renewal** - `updateState()` (called automatically when polling is enabled) re-establishes sessions as needed
3. **Auto-Accept** - When a peer sends an announcement, the SDK can automatically accept for existing contacts
4. **Message Processing** - After the session becomes active, queued messages are sent automatically

## Types

```typescript
import type {
  UserProfile,
  Contact,
  Discussion,
  Message,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '@massalabs/gossip-sdk';

import { SessionStatus, SdkEventType } from '@massalabs/gossip-sdk';
```

## Database

SQLite via [wa-sqlite](https://github.com/nicolo-ribaudo/wa-sqlite) (WASM) with [Drizzle ORM](https://orm.drizzle.team). Data is persisted to IndexedDB using `IDBBatchAtomicVFS`.

### Schema

Schema is defined in `src/db/schema/` with one file per table. Drizzle-kit generates SQL migrations from the schema.

### Migrations

Migrations live in `drizzle/` and are applied automatically on `initDb()` via Drizzle's built-in migrator.

When you change the schema, regenerate migrations:

```bash
npm run db:generate
```

This runs `drizzle-kit generate`, which diffs the schema against existing migrations and outputs a new `.sql` file in `drizzle/`. Commit the generated migration alongside your schema change.

## Testing

```bash
npm test           # Watch mode
npm run test:run   # Single run
```

Tests use wa-sqlite with in-memory databases for fast, isolated execution.

## Architecture

```
gossip-sdk/
├── drizzle/              # Generated SQL migrations
├── src/
│   ├── gossipSdk.ts      # SDK class & factory
│   ├── db/
│   │   ├── index.ts      # Barrel export (all DB access goes through here)
│   │   ├── schema/       # Drizzle table definitions (one file per table)
│   │   ├── queries/      # Query functions
│   │   └── sqlite.ts     # SQLite init, migration, connection
│   ├── api/
│   │   └── messageProtocol/  # REST protocol implementation
│   ├── config/
│   │   ├── protocol.ts   # API configuration
│   │   └── sdk.ts        # SDK configuration
│   ├── core/
│   │   ├── SdkEventEmitter.ts  # Event system
│   │   └── SdkPolling.ts       # Polling manager
│   ├── services/
│   │   ├── auth.ts       # Auth service
│   │   ├── message.ts    # Message service
│   │   ├── discussion.ts # Discussion service
│   │   ├── announcement.ts # Announcement service
│   │   └── refresh.ts    # Session refresh service
│   ├── utils/            # Utility modules
│   └── wasm/             # WASM module wrappers
└── test/                 # Test files
```

## License

MIT
