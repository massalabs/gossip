# Gossip SDK

A platform-agnostic SDK for the Gossip messenger app. This SDK enables automation, chatbot integrations, and programmatic access to Gossip functionality outside the React UI.

## Overview

The Gossip SDK provides a clean, typed interface for:

- **Account Management** - Create, load, restore, and manage user accounts
- **Contact Management** - Add, update, and delete contacts
- **Discussion Management** - Initialize and manage encrypted discussions
- **Message Operations** - Send and receive encrypted messages
- **Announcement Handling** - Process protocol announcements
- **Wallet Operations** - Interact with the Massa blockchain

## Installation

The SDK is designed to be used alongside the main Gossip application. It shares dependencies with the React app via peer dependencies.

```bash
cd gossip-sdk
npm install
```

### Peer Dependencies

The SDK requires these peer dependencies (provided by the parent project):

- `dexie` ^4.0.0 - IndexedDB wrapper for local storage
- `zustand` ^5.0.0 - State management

## Usage

### Basic Example

```typescript
import {
  initializeAccount,
  addContact,
  initializeDiscussion,
  sendMessage,
} from 'gossip-sdk';

// Create a new account
const accountResult = await initializeAccount('alice', 'secure-password');
if (!accountResult.success) {
  console.error('Failed to create account:', accountResult.error);
  return;
}

console.log('Account created:', accountResult.userProfile?.username);

// Add a contact (requires their public key)
const contactResult = await addContact(
  accountResult.userProfile.userId,
  'bob-user-id',
  'Bob',
  bobPublicKeys
);

if (contactResult.success) {
  console.log('Contact added:', contactResult.contact?.name);
}

// Start a discussion with the contact
const discussionResult = await initializeDiscussion(
  contactResult.contact,
  ourPublicKeys,
  ourSecretKeys,
  session,
  accountResult.userProfile.userId,
  'Hello Bob!'
);

if (discussionResult.success) {
  console.log('Discussion started, ID:', discussionResult.discussionId);
}
```

### Account Management

```typescript
import {
  initializeAccount,
  loadAccount,
  restoreAccountFromMnemonic,
  logout,
  resetAccount,
  showBackup,
  getAllAccounts,
  hasExistingAccount,
  getCurrentAccount,
} from 'gossip-sdk';

// Create a new account with username and password
const result = await initializeAccount('username', 'password');

// Load an existing account
const loadResult = await loadAccount('password', optionalUserId);

// Restore account from mnemonic phrase
const restoreResult = await restoreAccountFromMnemonic(
  'username',
  'word1 word2 word3 ... word12',
  'password'
);

// Get mnemonic backup for current account
const backup = await showBackup('password');
console.log('Mnemonic:', backup.mnemonic);

// Check if any accounts exist
const hasAccount = await hasExistingAccount();

// Get current logged-in account
const current = getCurrentAccount();

// Logout (keeps data, clears session)
await logout();

// Reset account (deletes all data)
await resetAccount();
```

### Contact Management

```typescript
import {
  getContacts,
  getContact,
  addContact,
  updateContactName,
  deleteContact,
} from 'gossip-sdk';

// Get all contacts for current user
const contacts = await getContacts(userId);

// Get a specific contact
const contact = await getContact(ownerUserId, contactUserId);

// Add a new contact
const result = await addContact(
  ownerUserId,
  contactUserId,
  'Alice',
  publicKeys
);

// Update contact name
await updateContactName(ownerUserId, contactUserId, 'Alice Smith');

// Delete contact and all associated data
await deleteContact(ownerUserId, contactUserId);
```

### Discussion Management

```typescript
import {
  getDiscussions,
  getDiscussion,
  initializeDiscussion,
  acceptDiscussionRequest,
  renewDiscussion,
  updateDiscussionName,
  isDiscussionStableState,
} from 'gossip-sdk';

// Get all discussions
const discussions = await getDiscussions(ownerUserId);

// Initialize a new discussion
const result = await initializeDiscussion(
  contact,
  ourPublicKeys,
  ourSecretKeys,
  session,
  userId,
  'Initial message'
);

// Accept incoming discussion request
await acceptDiscussionRequest(discussion, session, ourPk, ourSk);

// Check if discussion can send messages
const canSend = await isDiscussionStableState(ownerUserId, contactUserId);

// Renew a broken discussion
await renewDiscussion(ownerUserId, contactUserId, session, ourPk, ourSk);
```

### Message Operations

```typescript
import {
  getMessages,
  getMessage,
  sendMessage,
  fetchMessages,
  resendMessages,
} from 'gossip-sdk';

// Get messages for a discussion
const messages = await getMessages(ownerUserId, contactUserId);

// Send a message
const result = await sendMessage(message, session);

// Fetch new messages from server
const fetchResult = await fetchMessages(userId, secretKeys, session);

// Resend failed messages
await resendMessages(failedMessagesMap, session);
```

## API Reference

### Result Types

Most SDK functions return result objects with a consistent structure:

```typescript
interface Result<T> {
  success: boolean;
  error?: string; // Present when success is false
  data?: T; // Present when success is true
}
```

### Types

The SDK re-exports types from the main application:

```typescript
import type {
  UserProfile,
  Contact,
  Discussion,
  Message,
  DiscussionStatus,
  MessageStatus,
  MessageDirection,
  MessageType,
} from 'gossip-sdk';
```

## Testing

Run SDK tests:

```bash
npm test           # Watch mode
npm run test:run   # Single run
npm run test:coverage  # With coverage report
```

Tests use `fake-indexeddb` to simulate IndexedDB in Node.js environment.

## Architecture

The SDK wraps the existing Gossip application logic, providing:

1. **Stable Interface** - Functions with consistent signatures across versions
2. **Error Handling** - All async operations return result objects with error info
3. **Type Safety** - Full TypeScript support with exported types
4. **Platform Agnostic** - Works in Node.js, browsers, and other JS runtimes

### Path Aliases

The SDK uses path aliases to import from the main app:

- `@/*` resolves to `../src/*` (parent project source)

## Development

### Project Structure

```
gossip-sdk/
├── src/
│   ├── index.ts          # Main exports
│   ├── account.ts        # Account management wrapper
│   ├── auth.ts           # Authentication wrapper
│   ├── contacts.ts       # Contact operations wrapper
│   ├── discussions.ts    # Discussion management wrapper
│   ├── messages.ts       # Message operations wrapper
│   ├── announcements.ts  # Announcement handling wrapper
│   ├── wallet.ts         # Wallet operations wrapper
│   ├── types.ts          # Type re-exports
│   ├── utils.ts          # Utility functions
│   ├── db.ts             # Database (Dexie) implementation
│   ├── api/
│   │   └── messageProtocol/  # REST and mock protocol implementations
│   ├── config/
│   │   └── protocol.ts   # API configuration with runtime override
│   ├── crypto/           # Encryption and BIP39 utilities
│   ├── services/         # Core service implementations
│   │   ├── auth.ts       # Auth service
│   │   ├── message.ts    # Message service
│   │   ├── discussion.ts # Discussion service
│   │   └── announcement.ts # Announcement service
│   ├── utils/            # Utility modules
│   │   ├── userId.ts     # User ID encoding/decoding
│   │   ├── base64.ts     # Base64 encoding
│   │   ├── logs.ts       # Logging utility
│   │   └── ...           # Other utilities
│   └── wasm/             # WASM module wrappers
│       ├── loader.ts     # WASM initialization
│       ├── session.ts    # Session management
│       └── ...           # Other WASM utilities
├── test/
│   ├── setup.ts          # Test environment setup
│   ├── helpers.ts        # Test utilities
│   └── *.test.ts         # Test files
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### Adding New Functions

1. Identify the source function in `src/` (stores, services, utils)
2. Create a wrapper function with proper error handling
3. Add JSDoc documentation with examples
4. Export from module file and `index.ts`
5. Add corresponding tests

## Known Limitations & TODOs

### Store Coupling in deleteContact

The `deleteContact` function (`src/utils/contacts.ts`) still accesses `useAccountStore` from the React app to get the current user's session. This creates a coupling between the SDK and the React app's state management.

**Impact:** The `deleteContact` function will not work correctly in a pure Node.js environment without the React store being initialized.

**Future Solution:** Pass the session/userId explicitly as a parameter to `deleteContact`, making it fully independent of React stores.

### Workspace Setup for Imports

Currently, the React app imports from the SDK using relative paths like `../../gossip-sdk/src`. This works but is verbose.

**Future Solution:** Set up npm workspaces or TypeScript project references for cleaner imports like `import { authService } from 'gossip-sdk'`.

### Announcement Service Notifications

The SDK's `AnnouncementService` uses an injectable `NotificationHandler` interface for platform-agnostic notification support. However, the React app still uses its own copy with direct `notificationService` calls.

**Future Solution:** Update React app to use SDK's announcement service and inject the notification handler during app initialization.

## License

MIT
