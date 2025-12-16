# Gossip SDK

SDK for Gossip/Echo functionality - designed for automation, chatbot, and integration use cases.

## Overview

The Gossip SDK provides a set of plain functions (no React hooks) that expose core Gossip functionality. All functions are framework-agnostic and can be used in any JavaScript/TypeScript environment.

## Installation

The SDK is part of the Gossip project. To use it, import from the SDK directory:

```typescript
import { initializeAccount, sendMessage, getMessages } from './gossip-sdk/src';
```

**Note**: The SDK requires the parent project's dependencies to be available. Make sure you're running from the project root or have the necessary dependencies installed.

## Features

- **Account Management**: Create, load, restore, and manage user accounts
- **Authentication**: Fetch and publish public keys
- **Contact Management**: Add, update, and delete contacts
- **Discussions**: Initialize, accept, and manage discussions with contacts
- **Messages**: Send, receive, and manage messages
- **Announcements**: Handle session announcements
- **Wallet**: Manage wallet balances and token operations

## Usage Examples

### Account Management

```typescript
import { initializeAccount, loadAccount, logout } from './gossip-sdk/src';

// Create a new account
const result = await initializeAccount('username', 'password');
if (result.success) {
  console.log('Account created:', result.userProfile);
}

// Load an existing account
const loadResult = await loadAccount('password');
if (loadResult.success) {
  console.log('Account loaded:', loadResult.userProfile);
}

// Logout
await logout();
```

### Contact Management

```typescript
import {
  addContact,
  getContacts,
  updateContactName,
  getCurrentUserId,
} from './gossip-sdk/src';
import { generateUserKeys } from '../src/wasm/userKeys';
import { encodeUserId } from '../src/utils/userId';

const userId = getCurrentUserId();
if (!userId) throw new Error('Not logged in');

// Generate contact's public keys (in real usage, fetch from network)
const contactKeys = await generateUserKeys('contact mnemonic');
const contactPublicKeys = contactKeys.public_keys();
const contactUserId = encodeUserId(contactPublicKeys.derive_id());

// Add a contact
const contactResult = await addContact(
  userId,
  contactUserId,
  'Contact Name',
  contactPublicKeys
);

// Get all contacts
const contacts = await getContacts(userId);

// Update contact name
await updateContactName(userId, contactUserId, 'New Name');
```

### Sending Messages

```typescript
import { sendMessage, getMessages, getAccount } from './gossip-sdk/src';
import { MessageType, MessageDirection, MessageStatus } from './gossip-sdk/src';

const account = getAccount();
if (!account.session || !account.userProfile) {
  throw new Error('Account not initialized');
}

// Send a message
const messageResult = await sendMessage(
  {
    ownerUserId: account.userProfile.userId,
    contactUserId: 'gossip1contact123', // Bech32-encoded user ID
    content: 'Hello!',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENDING,
    timestamp: new Date(),
  },
  account.session
);

// Get messages
const messages = await getMessages(
  account.userProfile.userId,
  'gossip1contact123'
);
```

### Discussions

```typescript
import {
  initializeDiscussion,
  getDiscussions,
  acceptDiscussionRequest,
  getAccount,
  addContact,
} from './gossip-sdk/src';

const account = getAccount();
if (
  !account.session ||
  !account.ourPk ||
  !account.ourSk ||
  !account.userProfile
) {
  throw new Error('Account not initialized');
}

// First, add the contact
const contactResult = await addContact(
  account.userProfile.userId,
  contactUserId,
  'Contact Name',
  contactPublicKeys
);
if (!contactResult.success || !contactResult.contact) {
  throw new Error('Failed to add contact');
}

// Initialize a discussion
const discussionResult = await initializeDiscussion(
  contactResult.contact,
  account.ourPk,
  account.ourSk,
  account.session,
  account.userProfile.userId,
  "Hello, let's chat!"
);

// Get all discussions
const discussions = await getDiscussions(account.userProfile.userId);
```

## API Reference

### Account Functions

- `initializeAccount(username, password)` - Create new account
- `loadAccount(password?, userId?)` - Load existing account
- `restoreAccountFromMnemonic(username, mnemonic, password)` - Restore from mnemonic
- `logout()` - Logout current account
- `resetAccount()` - Delete current account
- `getAllAccounts()` - List all accounts
- `hasExistingAccount()` - Check if account exists
- `getCurrentAccount()` - Get current account info
- `showBackup(password?)` - Get mnemonic backup
- `getMnemonicBackupInfo()` - Get backup info
- `markMnemonicBackupComplete()` - Mark backup as complete

### Auth Functions

- `fetchPublicKeyByUserId(userId)` - Fetch contact's public key
- `ensurePublicKeyPublished(publicKeys, userId)` - Publish own public key

### Contact Functions

- `addContact(ownerUserId, userId, name, publicKeys)` - Add new contact
- `getContacts(ownerUserId)` - Get all contacts
- `getContact(ownerUserId, contactUserId)` - Get specific contact
- `updateContactName(ownerUserId, contactUserId, newName)` - Update contact name
- `deleteContact(ownerUserId, contactUserId)` - Delete contact

### Discussion Functions

- `initializeDiscussion(contact, ourPk, ourSk, session, userId, message?)` - Start new discussion
- `acceptDiscussionRequest(discussion, session, ourPk, ourSk)` - Accept incoming discussion
- `renewDiscussion(ownerUserId, contactUserId, session, ourPk, ourSk)` - Renew broken discussion
- `getDiscussions(ownerUserId)` - Get all discussions
- `getDiscussion(ownerUserId, contactUserId)` - Get specific discussion
- `updateDiscussionName(discussionId, newName)` - Update discussion custom name
- `isDiscussionStableState(ownerUserId, contactUserId)` - Check if discussion is stable

### Message Functions

- `sendMessage(message, session)` - Send a message
- `fetchMessages(userId, ourSk, session)` - Fetch new messages
- `resendMessages(messages, session)` - Resend failed messages
- `getMessages(ownerUserId, contactUserId?)` - Get messages from database
- `getMessage(messageId)` - Get specific message
- `findMessageBySeeker(seeker, ownerUserId)` - Find message by seeker

### Announcement Functions

- `fetchAndProcessAnnouncements(ourPk, ourSk, session)` - Fetch and process announcements
- `resendAnnouncements(failedDiscussions, session)` - Resend failed announcements
- `establishSession(contactPublicKeys, ourPk, ourSk, session, userData?)` - Establish session
- `sendAnnouncement(announcement)` - Send announcement

### Wallet Functions

- `refreshBalances()` - Refresh all token balances
- `refreshBalance(tokenIndex)` - Refresh specific token balance
- `getTokenBalances(provider)` - Get token balances
- `getTokens()` - Get token list
- `setFeeConfig(config)` - Set fee configuration
- `getFeeConfig()` - Get fee configuration

### Utility Functions

- `getSession()` - Get current session module (returns `SessionModule | null`)
- `getAccount()` - Get current account state (returns object with `userProfile`, `encryptionKey`, `ourPk`, `ourSk`, `session`)
- `ensureInitialized()` - Ensure account is loaded (throws if not initialized)
- `getCurrentUserId()` - Get current user ID (returns `string | null`)

## Testing

The SDK includes a comprehensive test suite using Vitest. All tests use the real WASM implementation and MOCK message protocol (no network calls).

Run tests with:

```bash
cd gossip-sdk
npm test
```

Run tests once (no watch mode):

```bash
npm run test:run
```

Run tests with coverage:

```bash
npm run test:coverage
```

**Note**: Tests use `fake-indexeddb` to simulate IndexedDB in Node.js environment. The test suite includes:

- Account management tests
- Authentication tests
- Contact management tests
- Discussion management tests
- Message operations tests (including a 5-message exchange test)
- Announcement handling tests
- Wallet operations tests

## Error Handling

All functions return result objects with a `success` boolean and optional `error` string:

```typescript
const result = await someFunction();
if (result.success) {
  // Handle success
} else {
  console.error('Error:', result.error);
}
```

## TypeScript Support

The SDK is fully typed. Import types as needed:

```typescript
import type {
  Contact,
  Message,
  Discussion,
  UserProfile,
  MessageStatus,
  DiscussionStatus,
} from './gossip-sdk/src';
```

## Notes

- All functions are async and return Promises
- Functions that require authentication will throw if account is not loaded
- Session and keys should be retrieved using `getAccount()` when not passed as parameters
- The SDK reuses existing services and stores from the main application
- Database operations use Dexie/IndexedDB
- User IDs must be Bech32-encoded strings (format: `gossip1...`)
- Public keys must be `UserPublicKeys` instances (created via `generateUserKeys()` or `UserPublicKeys.from_bytes()`)
- The SDK uses the MOCK message protocol in tests to avoid network calls

## License

Same as the main Gossip project.
