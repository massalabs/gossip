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

The SDK uses a factory pattern — each call to `createGossipSdk()` returns a new instance:

```typescript
import { createGossipSdk } from '@massalabs/gossip-sdk';

const sdk = createGossipSdk();

// 1. Initialize (optional config)
await sdk.init();

// 2. Open session (login)
await sdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
});

// 3. Use the SDK
const contacts = await sdk.contacts.list(sdk.userId);
await sdk.discussions.start(contact);
await sdk.messages.send(message);

// 4. Listen to events
sdk.on(SdkEventType.MESSAGE_RECEIVED, msg => {
  console.log('New message:', msg);
});

// 5. Logout
await sdk.closeSession();
```

## Lifecycle

### 1. Initialize

Call `init()` once at app startup. All options are optional:

```typescript
// Uses GOSSIP_API_URL / VITE_GOSSIP_API_URL env var, or defaults to api.usegossip.com
await sdk.init();

// Or with explicit config
await sdk.init({
  protocolBaseUrl: 'https://api.usegossip.com',
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
  ownerUserId: sdk.userId,
  contactUserId: contactId,
  content: 'Hello!',
  type: MessageType.TEXT,
  direction: MessageDirection.OUTGOING,
  status: MessageStatus.SENDING,
  timestamp: new Date(),
});

// Fetch new messages from server
const fetchResult = await sdk.messages.fetch();

// Find message by messageId
const msg = await gossipSdk.messages.findByMsgId(messageId, ownerUserId);

// Mark as read
await sdk.messages.markAsRead(messageId);
```

### Discussions

```typescript
// Start a new discussion
const result = await sdk.discussions.start(contact);

// Accept an incoming discussion request
await sdk.discussions.accept(discussion);

// Renew a broken session
await sdk.discussions.renew(contactUserId);

// Get session status for a contact
const status = sdk.discussions.getStatus(contactUserId);

// List all discussions
const discussions = await sdk.discussions.list(ownerUserId);

// Get a specific discussion
const discussion = await sdk.discussions.get(ownerUserId, contactUserId);
```

### Contacts

```typescript
// List all contacts
const contacts = await sdk.contacts.list(ownerUserId);

// Get a specific contact
const contact = await sdk.contacts.get(ownerUserId, contactUserId);

// Add a new contact
const result = await sdk.contacts.add(
  ownerUserId,
  contactUserId,
  'Alice',
  publicKeys
);

// Update contact name
await sdk.contacts.updateName(ownerUserId, contactUserId, 'Alice Smith');

// Delete contact and all associated data
await sdk.contacts.delete(ownerUserId, contactUserId);
```

### Announcements

```typescript
// Fetch and process announcements from server
const result = await sdk.announcements.fetch();
```

### Auth (Available after init, before session)

```typescript
// Publish public key so the user is discoverable
await sdk.auth.ensurePublicKeyPublished(publicKey, userId);
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
      baseUrl: 'https://api.usegossip.com',
      timeout: 10000,
      retryAttempts: 3,
    },
    polling: {
      enabled: false,
      messagesIntervalMs: 5000,
      announcementsIntervalMs: 10000,
      sessionRefreshIntervalMs: 30000,
    },
    messages: {
      fetchDelayMs: 100,
      maxFetchIterations: 30,
      deduplicationWindowMs: 30000,
    },
    announcements: {
      fetchLimit: 500,
      brokenThresholdMs: 3600000,
    },
  },
});
```

## Session Persistence

For restoring sessions across app restarts:

```typescript
await sdk.openSession({
  mnemonic,
  encryptionKey,
  onPersist: async (blob, key) => {
    await storage.save({ session: blob });
  },
});
```

## Auto-Renewal Behavior

The SDK automatically handles session recovery:

1. **Session Lost** - When a session is killed/lost, messages are queued as `WAITING_SESSION`
2. **Auto-Renewal** - SDK emits `onSessionRenewalNeeded` and attempts renewal
3. **Auto-Accept** - When peer sends announcement, SDK auto-accepts for existing contacts
4. **Message Processing** - After session becomes active, queued messages are sent automatically

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

## Testing

```bash
npm test           # Watch mode
npm run test:run   # Single run
```

Tests use `fake-indexeddb` to simulate IndexedDB in Node.js environment.

## Architecture

```
gossip-sdk/
├── src/
│   ├── gossipSdk.ts      # SDK class & factory
│   ├── db.ts             # Database (Dexie) implementation
│   ├── contacts.ts       # Contact operations
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
│   ├── types/            # Type definitions
│   ├── utils/            # Utility modules
│   └── wasm/             # WASM module wrappers
└── test/                 # Test files
```

## License

MIT
