# Gossip SDK

A platform-agnostic SDK for the Gossip messenger app. This SDK enables automation, chatbot integrations, and programmatic access to Gossip functionality.

## Overview

The Gossip SDK provides a clean, typed interface for:

- **Account Management** - Create, load, restore, and manage user accounts
- **Contact Management** - Add, update, and delete contacts
- **Discussion Management** - Initialize and manage encrypted discussions
- **Message Operations** - Send and receive encrypted messages
- **Announcement Handling** - Process protocol announcements
- **Session Management** - Automatic session renewal and persistence

## Installation

```bash
cd gossip-sdk
npm install
```

### Peer Dependencies

The SDK requires these peer dependencies (provided by the host project):

- `dexie` ^4.0.0 - IndexedDB wrapper for local storage

## Quick Start

The SDK uses a singleton pattern with a simple lifecycle:

```typescript
import { gossipSdk, GossipDatabase } from 'gossip-sdk';

// 1. Initialize once at app startup
const db = new GossipDatabase();
await db.open();

await gossipSdk.init({
  db,
  protocolBaseUrl: 'https://api.example.com',
});

// 2. Open session (login)
await gossipSdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  // For existing session:
  encryptedSession: savedBlob,
  encryptionKey: savedKey,
  // For persistence:
  persistEncryptionKey: encryptionKey,
  onPersist: async (blob, key) => {
    await saveToStorage(blob, key);
  },
});

// 3. Use the SDK
const contacts = await gossipSdk.contacts.list(gossipSdk.userId);
await gossipSdk.discussions.start(contact, 'Hello!');
await gossipSdk.messages.send(message);

// 4. Listen to events
gossipSdk.on('message', msg => {
  console.log('New message:', msg.content);
});

// 5. Logout
await gossipSdk.closeSession();
```

## Lifecycle

### 1. Initialize

Call `init()` once at app startup to configure the database and protocol:

```typescript
await gossipSdk.init({
  // Required: Database instance
  db: new GossipDatabase(),

  // Optional: API base URL (uses default if not provided)
  protocolBaseUrl: 'https://api.usegossip.net',

  // Optional: Configuration overrides
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
await gossipSdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
});

// Restore existing session
await gossipSdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  encryptedSession: savedBlob,
  encryptionKey: savedKey,
});

// With persistence (saves session on changes)
await gossipSdk.openSession({
  mnemonic: 'word1 word2 word3 ... word12',
  persistEncryptionKey: encryptionKey,
  onPersist: async (blob, key) => {
    await db.userProfile.update(userId, { session: blob });
  },
});
```

### 3. Close Session (Logout)

```typescript
await gossipSdk.closeSession();
```

## Service APIs

All services are available after `openSession()` is called.

### Messages

```typescript
// Send a message
const result = await gossipSdk.messages.send({
  ownerUserId: gossipSdk.userId,
  contactUserId: contactId,
  content: 'Hello!',
  type: MessageType.TEXT,
  direction: MessageDirection.OUTGOING,
  status: MessageStatus.SENDING,
  timestamp: new Date(),
});

// Fetch new messages from server
const fetchResult = await gossipSdk.messages.fetch();

// Resend failed messages
await gossipSdk.messages.resend(failedMessagesMap);

// Find message by seeker
const msg = await gossipSdk.messages.findBySeeker(seeker, ownerUserId);
```

### Discussions

```typescript
// Start a new discussion
const { discussionId } = await gossipSdk.discussions.start(contact, 'Hello!');

// Accept an incoming discussion request
await gossipSdk.discussions.accept(discussion);

// Renew a broken session
await gossipSdk.discussions.renew(contactUserId);

// Check if discussion can send messages
const canSend = await gossipSdk.discussions.isStable(
  ownerUserId,
  contactUserId
);

// List all discussions
const discussions = await gossipSdk.discussions.list(ownerUserId);

// Get a specific discussion
const discussion = await gossipSdk.discussions.get(ownerUserId, contactUserId);
```

### Contacts

```typescript
// List all contacts
const contacts = await gossipSdk.contacts.list(ownerUserId);

// Get a specific contact
const contact = await gossipSdk.contacts.get(ownerUserId, contactUserId);

// Add a new contact
const result = await gossipSdk.contacts.add(
  ownerUserId,
  contactUserId,
  'Alice',
  publicKeys
);

// Update contact name
await gossipSdk.contacts.updateName(ownerUserId, contactUserId, 'Alice Smith');

// Delete contact and all associated data
await gossipSdk.contacts.delete(ownerUserId, contactUserId);
```

### Announcements

```typescript
// Fetch and process announcements from server
const result = await gossipSdk.announcements.fetch();

// Resend failed announcements
await gossipSdk.announcements.resend(failedDiscussions);
```

### Auth (Available before session)

```typescript
// Create a new account
const result = await gossipSdk.auth.createAccount(
  username,
  mnemonic,
  encryptionKey
);

// Restore account from mnemonic
const result = await gossipSdk.auth.restoreAccount(
  username,
  mnemonic,
  encryptionKey
);
```

### Refresh

```typescript
// Handle session refresh for active discussions
await gossipSdk.refresh.handleSessionRefresh(activeDiscussions);
```

## Events

Subscribe to SDK events for real-time updates:

```typescript
// Message events
gossipSdk.on('message', message => {
  // New message received
});

gossipSdk.on('messageSent', message => {
  // Message sent successfully
});

gossipSdk.on('messageFailed', (message, error) => {
  // Message failed to send
});

// Discussion events
gossipSdk.on('discussionRequest', (discussion, contact) => {
  // Incoming discussion request
});

gossipSdk.on('discussionStatusChanged', discussion => {
  // Discussion status changed
});

// Session events
gossipSdk.on('sessionBroken', discussion => {
  // Session broken (deprecated - use auto-renewal)
});

gossipSdk.on('sessionRenewed', discussion => {
  // Session successfully renewed
});

// Error handling
gossipSdk.on('error', (error, context) => {
  console.error(`Error in ${context}:`, error);
});

// Unsubscribe
gossipSdk.off('message', handler);
```

## Polling

The SDK can automatically poll for messages, announcements, and session refresh:

```typescript
// Enable via config
await gossipSdk.init({
  db,
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
gossipSdk.polling.start();
gossipSdk.polling.stop();
console.log(gossipSdk.polling.isRunning);
```

## Session Info

Access session information after `openSession()`:

```typescript
// User ID (encoded string)
const userId = gossipSdk.userId;

// User ID (raw bytes)
const userIdBytes = gossipSdk.userIdBytes;

// Public keys
const publicKeys = gossipSdk.publicKeys;

// Check session state
console.log(gossipSdk.isInitialized); // true after init()
console.log(gossipSdk.isSessionOpen); // true after openSession()

// Get encrypted session for manual persistence
const blob = gossipSdk.getEncryptedSession(encryptionKey);
```

## Configuration

Full configuration options with defaults:

```typescript
await gossipSdk.init({
  db,
  config: {
    // Network settings
    protocol: {
      baseUrl: 'https://api.usegossip.net', // API endpoint
      timeout: 10000, // Request timeout (ms)
      retryAttempts: 3, // Retry count
    },

    // Polling settings
    polling: {
      enabled: false, // Auto-start polling
      messagesIntervalMs: 5000, // Message fetch interval
      announcementsIntervalMs: 10000, // Announcement fetch interval
      sessionRefreshIntervalMs: 30000, // Session refresh interval
    },

    // Message settings
    messages: {
      fetchDelayMs: 100, // Delay between fetch iterations
      maxFetchIterations: 30, // Max iterations per fetch call
      deduplicationWindowMs: 30000, // Duplicate detection window
    },

    // Announcement settings
    announcements: {
      fetchLimit: 500, // Max announcements per request
      brokenThresholdMs: 3600000, // Time before marking broken (1 hour)
    },
  },
});
```

## Utilities

```typescript
const utils = gossipSdk.utils;

// Validate user ID format
const result = utils.validateUserId(userId);
if (!result.valid) console.error(result.error);

// Validate username format
const result = utils.validateUsername(username);

// Encode/decode user IDs
const encoded = utils.encodeUserId(rawBytes);
const decoded = utils.decodeUserId(encodedString);
```

## Session Persistence

For restoring sessions across app restarts:

```typescript
// Option 1: Provide persistence config in openSession
await gossipSdk.openSession({
  mnemonic,
  persistEncryptionKey: key,
  onPersist: async (blob, key) => {
    // Save blob to your storage
    await db.userProfile.update(userId, { session: blob });
  },
});

// Option 2: Configure persistence after account creation
await gossipSdk.openSession({ mnemonic });
// ... create account, get encryption key ...
gossipSdk.configurePersistence(encryptionKey, async (blob, key) => {
  await db.userProfile.update(userId, { session: blob });
});
```

## Auto-Renewal Behavior

The SDK automatically handles session recovery:

1. **Session Lost** - When a session is killed/lost, messages are queued as `WAITING_SESSION`
2. **Auto-Renewal** - SDK emits `onSessionRenewalNeeded` and attempts renewal
3. **Auto-Accept** - When peer sends announcement, SDK auto-accepts for existing contacts
4. **Message Processing** - After session becomes active, queued messages are sent automatically

See [STATUS-REFERENCE.md](./docs/STATUS-REFERENCE.md) for detailed status documentation.

## Types

Import types from the SDK:

```typescript
import type {
  UserProfile,
  Contact,
  Discussion,
  Message,
  DiscussionStatus,
  DiscussionDirection,
  MessageStatus,
  MessageDirection,
  MessageType,
} from 'gossip-sdk';
```

## Testing

```bash
npm test           # Watch mode
npm run test:run   # Single run
npm run test:coverage  # With coverage report
```

Tests use `fake-indexeddb` to simulate IndexedDB in Node.js environment.

## Architecture

```
gossip-sdk/
├── src/
│   ├── gossipSdk.ts      # Main singleton SDK class
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
│   ├── types/
│   │   └── events.ts     # Event type definitions
│   ├── utils/            # Utility modules
│   └── wasm/             # WASM module wrappers
├── test/                 # Test files
├── docs/
│   └── STATUS-REFERENCE.md  # Status documentation
└── README.md
```

## License

MIT
