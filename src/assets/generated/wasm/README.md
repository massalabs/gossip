# Gossip WASM - WebAssembly Bindings

This crate provides WebAssembly bindings for the Gossip secure messaging system, exposing the SessionManager and Auth facilities to JavaScript/TypeScript applications.

## Features

- **Session Management**: Create, persist, and manage encrypted messaging sessions
- **Authentication**: Generate and manage cryptographic keys from passphrases
- **Post-Quantum Security**: Uses ML-KEM and ML-DSA for quantum-resistant cryptography
- **Encrypted State**: Secure serialization and deserialization of session state
- **Seeker-based Addressing**: Messages use hashed Massa public keys for efficient lookups

## Building

### Prerequisites

- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-pack (optional, for generating npm package)

### Build with Cargo

```bash
cargo build --target wasm32-unknown-unknown --release
```

The compiled WASM module will be at:

```
../target/wasm32-unknown-unknown/release/gossip_wasm.wasm
```

### Build with wasm-pack

For a complete npm-ready package with TypeScript definitions:

```bash
wasm-pack build --target web
```

## Usage

### JavaScript/TypeScript

```typescript
import init, {
  SessionManagerWrapper,
  SessionConfig,
  generate_user_keys,
  EncryptionKey,
} from './gossip_wasm';

// Initialize WASM
await init();

// Generate user keys from passphrase
const keys = generate_user_keys('my secure passphrase');
const publicKeys = keys.public_keys();
const secretKeys = keys.secret_keys();
const userId = publicKeys.derive_id();

// Create session manager with default configuration
const config = SessionConfig.new_default();
const manager = new SessionManagerWrapper(config);

// Establish session with peer
const peerKeys = generate_user_keys('peer passphrase');
const userData = new TextEncoder().encode('contact_request'); // Optional user data
const announcement = manager.establish_outgoing_session(
  peerKeys.public_keys(),
  publicKeys,
  secretKeys,
  userData
);
// Publish announcement to blockchain...

// Feed incoming announcement from peer
const result = manager.feed_incoming_announcement(
  announcementBytes,
  publicKeys,
  secretKeys
);
if (result) {
  console.log('Announcer public keys:', result.announcer_public_keys);
  console.log('Timestamp:', result.timestamp);
  console.log('User data:', new TextDecoder().decode(result.user_data));
}

// Send a message (raw bytes)
const messageBytes = new TextEncoder().encode('Hello!');
const peerId = peerKeys.public_keys().derive_id();
const sendOutput = manager.send_message(peerId, messageBytes);
if (sendOutput) {
  // Publish sendOutput.seeker and sendOutput.data to blockchain
  console.log('Seeker:', sendOutput.seeker);
  console.log('Data length:', sendOutput.data.length);
}

// Check for incoming messages
const seekers = manager.get_message_board_read_keys();
for (let i = 0; i < seekers.length; i++) {
  const seeker = seekers.get(i);
  // Read from blockchain using seeker...
  const received = manager.feed_incoming_message_board_read(
    seeker,
    data, // encrypted message data
    secretKeys
  );
  if (received) {
    console.log('Received:', new TextDecoder().decode(received.message));
    console.log('Timestamp:', received.timestamp);
    // Check acknowledged seekers
    const acks = received.acknowledged_seekers;
    for (let j = 0; j < acks.length; j++) {
      console.log('Acknowledged:', acks.get(j));
    }
  }
}

// Persist session state
const encryptionKey = EncryptionKey.generate();
const encrypted = manager.to_encrypted_blob(encryptionKey);
// Save encrypted blob to storage...

// Restore session state
const restored = SessionManagerWrapper.from_encrypted_blob(
  encrypted,
  encryptionKey
);
```

### Custom Configuration

```typescript
const config = new SessionConfig(
  604800000, // max_incoming_announcement_age_millis (1 week)
  60000, // max_incoming_announcement_future_millis (1 minute)
  604800000, // max_incoming_message_age_millis (1 week)
  60000, // max_incoming_message_future_millis (1 minute)
  604800000, // max_session_inactivity_millis (1 week)
  86400000, // keep_alive_interval_millis (1 day)
  10000 // max_session_lag_length
);
```

## API Reference

### AEAD Encryption Functions

Direct access to AES-256-SIV authenticated encryption:

- `aead_encrypt(key: EncryptionKey, nonce: Nonce, plaintext: Uint8Array, aad: Uint8Array)`: Encrypt data
- `aead_decrypt(key: EncryptionKey, nonce: Nonce, ciphertext: Uint8Array, aad: Uint8Array)`: Decrypt data

#### AEAD Example

```typescript
import {
  EncryptionKey,
  Nonce,
  aead_encrypt,
  aead_decrypt,
} from './gossip_wasm';

// Generate key and nonce
const key = EncryptionKey.generate();
const nonce = Nonce.generate();

// Encrypt some data
const plaintext = new TextEncoder().encode('Secret message');
const aad = new TextEncoder().encode('context info'); // Additional authenticated data
const ciphertext = aead_encrypt(key, nonce, plaintext, aad);

// Decrypt
const decrypted = aead_decrypt(key, nonce, ciphertext, aad);
if (decrypted) {
  console.log('Success:', new TextDecoder().decode(decrypted));
} else {
  console.error('Decryption failed - tampering detected!');
}
```

**Security Notes:**

- Nonces should be unique per encryption (16 bytes)
- AAD (Additional Authenticated Data) is authenticated but NOT encrypted
- AES-SIV is nonce-misuse resistant - reusing nonces only leaks if plaintexts are identical
- Keys are 64 bytes (512 bits) for AES-256-SIV

### SessionManagerWrapper

Main class for managing messaging sessions.

- `new(config: SessionConfig)`: Create new session manager
- `from_encrypted_blob(blob: Uint8Array, key: EncryptionKey)`: Restore from encrypted state
- `to_encrypted_blob(key: EncryptionKey)`: Serialize to encrypted blob
- `establish_outgoing_session(peer_pk, our_pk, our_sk, user_data: Uint8Array)`: Initiate session with peer, including optional user data (returns announcement bytes)
- `feed_incoming_announcement(bytes, our_pk, our_sk)`: Process incoming announcement (returns AnnouncementResult with announcer's public keys and user data, or undefined)
- `send_message(peer_id: Uint8Array, message_contents: Uint8Array)`: Send raw message bytes to peer
- `feed_incoming_message_board_read(seeker, data, our_sk)`: Process incoming messages
- `get_message_board_read_keys()`: Get seekers to monitor for incoming messages
- `peer_list()`: Get all peer IDs
- `peer_session_status(peer_id: Uint8Array)`: Get session status
- `peer_discard(peer_id: Uint8Array)`: Remove peer
- `refresh()`: Refresh sessions and get keep-alive announcement list

### AnnouncementResult

Result from processing an incoming announcement:

- `announcer_public_keys(): UserPublicKeys`: The public keys of the peer who sent the announcement
- `timestamp(): number`: Unix timestamp in milliseconds when the announcement was created
- `user_data(): Uint8Array`: Arbitrary user data embedded in the announcement (can be empty)

**Use Cases for User Data:**

- Contact requests with metadata
- Version information
- Application-specific handshake data
- Display names or profile information
- Protocol negotiation parameters

**⚠️ Security Warning:**

The user_data in announcements has **reduced security compared to regular messages**:

- ✅ **Plausible deniability preserved**: The user_data is not cryptographically signed, so the sender can deny specific content
- ❌ **No post-compromise secrecy**: If long-term keys are compromised, past announcements can be decrypted

**Recommendation**: Use user_data for non-highly-sensitive metadata. Send truly sensitive information through regular messages after the session is established.

### SendMessageOutput

Output from sending a message:

- `seeker(): Uint8Array`: Database key for message lookup on message board
- `data(): Uint8Array`: Encrypted message data to publish
- `timestamp(): number`: Message timestamp (milliseconds since Unix epoch)

### ReceiveMessageOutput

Output from receiving a message:

- `message(): Uint8Array`: Decrypted message contents
- `timestamp(): number`: Message timestamp (milliseconds since Unix epoch)
- `acknowledged_seekers()`: Array of seekers that were acknowledged

### Auth Functions

- `generate_user_keys(passphrase: string)`: Generate keys from passphrase using password KDF

### Other Classes

- `SessionConfig`: Session manager configuration
- `EncryptionKey`: AES-256-SIV key (64 bytes)
  - `generate()`: Generate random key
  - `from_bytes(bytes: Uint8Array)`: Create from bytes
  - `to_bytes()`: Get raw bytes
- `Nonce`: AES-256-SIV nonce (16 bytes)
  - `generate()`: Generate random nonce
  - `from_bytes(bytes: Uint8Array)`: Create from bytes
  - `to_bytes()`: Get raw bytes
- `UserPublicKeys`: User's public keys
  - `derive_id()`: Get user ID (32 bytes)
  - `to_bytes()`: Serialize to bytes
- `UserSecretKeys`: User's secret keys
- `SessionStatus`: Enum for session states (Active, Inactive, etc.)

## Architecture

The Gossip system uses a multi-layer architecture:

1. **Crypto Primitives**: ML-KEM (post-quantum KEM), ML-DSA (post-quantum signatures), AES-SIV (AEAD)
2. **Agraphon Protocol**: Double-ratchet encryption with forward secrecy and post-compromise security
3. **Session Layer**: Manages Agraphon sessions with seeker-based addressing using hashed Massa public keys
4. **Session Manager**: High-level API for multi-peer messaging with session lifecycle management

Messages are identified by "seekers" - database keys derived from hashing ephemeral Massa public keys. This allows:

- Efficient message lookup on public message boards
- Privacy (seekers don't reveal sender/recipient identity)
- Unlinkability (each message uses a fresh keypair)
