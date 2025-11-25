/* tslint:disable */
/* eslint-disable */
export function start(): void;
/**
 * Generates user keys from a passphrase using password-based key derivation.
 */
export function generate_user_keys(passphrase: string): UserKeys;
/**
 * Encrypts data using AES-256-SIV authenticated encryption.
 *
 * # Parameters
 *
 * - `key`: The encryption key (64 bytes)
 * - `nonce`: The nonce (16 bytes, should be unique per encryption)
 * - `plaintext`: The data to encrypt
 * - `aad`: Additional authenticated data (not encrypted, but authenticated)
 *
 * # Returns
 *
 * The ciphertext with authentication tag appended.
 *
 * # Security Notes
 *
 * - The nonce should be unique for each encryption operation
 * - AES-SIV is nonce-misuse resistant: reusing nonces only leaks if plaintexts are identical
 * - AAD is authenticated but not encrypted; it must be transmitted separately
 * - The same AAD must be provided during decryption
 *
 * # Example
 *
 * ```javascript
 * const key = EncryptionKey.generate();
 * const nonce = Nonce.generate();
 * const plaintext = new TextEncoder().encode("Secret message");
 * const aad = new TextEncoder().encode("context info");
 *
 * const ciphertext = aead_encrypt(key, nonce, plaintext, aad);
 * ```
 */
export function aead_encrypt(key: EncryptionKey, nonce: Nonce, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
/**
 * Decrypts data using AES-256-SIV authenticated encryption.
 *
 * # Parameters
 *
 * - `key`: The encryption key (64 bytes, must match encryption key)
 * - `nonce`: The nonce (16 bytes, must match encryption nonce)
 * - `ciphertext`: The encrypted data with authentication tag
 * - `aad`: Additional authenticated data (must match encryption AAD)
 *
 * # Returns
 *
 * The decrypted plaintext, or `null` if authentication fails.
 *
 * # Security Notes
 *
 * - Returns `null` if:
 *   - The ciphertext has been tampered with
 *   - The wrong key or nonce is used
 *   - The AAD doesn't match
 * - Never ignore a decryption failure; it indicates tampering or corruption
 *
 * # Example
 *
 * ```javascript
 * const plaintext = aead_decrypt(key, nonce, ciphertext, aad);
 * if (plaintext) {
 *     console.log("Decrypted:", new TextDecoder().decode(plaintext));
 * } else {
 *     console.error("Decryption failed - data may be corrupted or tampered");
 * }
 * ```
 */
export function aead_decrypt(key: EncryptionKey, nonce: Nonce, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array | undefined;
/**
 * Session status indicating the state of a peer session.
 */
export enum SessionStatus {
  Active = 0,
  UnknownPeer = 1,
  NoSession = 2,
  PeerRequested = 3,
  SelfRequested = 4,
  Killed = 5,
  Saturated = 6,
}
/**
 * Result from feeding an incoming announcement.
 */
export class AnnouncementResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Gets the announcer's public keys.
   */
  readonly announcer_public_keys: UserPublicKeys;
  /**
   * Gets the announcement timestamp in milliseconds since Unix epoch.
   */
  readonly timestamp: number;
  /**
   * Gets the user data embedded in the announcement.
   */
  readonly user_data: Uint8Array;
}
/**
 * Encryption key for AEAD operations (AES-256-SIV).
 *
 * AES-256-SIV uses a 64-byte (512-bit) key: two 256-bit keys for encryption and MAC.
 */
export class EncryptionKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Generates a new random encryption key (64 bytes).
   */
  static generate(): EncryptionKey;
  /**
   * Generates a deterministic encryption key (64 bytes) from a seed and salt.
   *
   * Uses Argon2id via `crypto_password_kdf` to derive a 64-byte key suitable for
   * AES-256-SIV (which requires 64 bytes: 2×256-bit keys).
   *
   * - `seed`: application-provided seed string (treat like a password)
   * - `salt`: unique, random salt (minimum 8 bytes, recommended 16+ bytes)
   */
  static from_seed(seed: string, salt: Uint8Array): EncryptionKey;
  /**
   * Creates an encryption key from raw bytes (must be 64 bytes).
   */
  static from_bytes(bytes: Uint8Array): EncryptionKey;
  /**
   * Gets the raw bytes of the encryption key.
   */
  to_bytes(): Uint8Array;
}
/**
 * Nonce for AEAD operations (AES-256-SIV).
 *
 * AES-256-SIV uses a 16-byte (128-bit) nonce. The nonce should be unique
 * per encryption for maximum security, though SIV mode is nonce-misuse resistant.
 */
export class Nonce {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Generates a new random nonce (16 bytes).
   */
  static generate(): Nonce;
  /**
   * Creates a nonce from raw bytes (must be 16 bytes).
   */
  static from_bytes(bytes: Uint8Array): Nonce;
  /**
   * Gets the raw bytes of the nonce.
   */
  to_bytes(): Uint8Array;
}
/**
 * Output from receiving a message.
 */
export class ReceiveMessageOutput {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Gets the received message contents.
   */
  readonly message: Uint8Array;
  /**
   * Gets the message timestamp (milliseconds since Unix epoch).
   */
  readonly timestamp: number;
  /**
   * Gets the list of newly acknowledged seekers.
   */
  readonly acknowledged_seekers: Array<any>;
  /**
   * Gets the sender's user id (32 bytes).
   */
  readonly user_id: Uint8Array;
}
/**
 * Output from sending a message.
 */
export class SendMessageOutput {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Gets the seeker (identifier for message board lookup).
   */
  readonly seeker: Uint8Array;
  /**
   * Gets the encrypted message data.
   */
  readonly data: Uint8Array;
}
/**
 * Session manager configuration for controlling session behavior.
 */
export class SessionConfig {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Creates a new session configuration with the given parameters.
   */
  constructor(max_incoming_announcement_age_millis: number, max_incoming_announcement_future_millis: number, max_incoming_message_age_millis: number, max_incoming_message_future_millis: number, max_session_inactivity_millis: number, keep_alive_interval_millis: number, max_session_lag_length: bigint);
  /**
   * Creates a default configuration with sensible defaults:
   * - Announcement age: 1 week
   * - Announcement future: 1 minute
   * - Message age: 1 week
   * - Message future: 1 minute
   * - Session inactivity: 1 week
   * - Keep-alive interval: 1 day
   * - Max lag: 10000 messages
   */
  static new_default(): SessionConfig;
}
/**
 * Session manager wrapper for WebAssembly.
 */
export class SessionManagerWrapper {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Creates a new session manager with the given configuration.
   */
  constructor(config: SessionConfig);
  /**
   * Deserializes a session manager from an encrypted blob.
   */
  static from_encrypted_blob(encrypted_blob: Uint8Array, key: EncryptionKey): SessionManagerWrapper;
  /**
   * Serializes and encrypts the session manager into a blob.
   */
  to_encrypted_blob(key: EncryptionKey): Uint8Array;
  /**
   * Establishes an outgoing session with a peer.
   *
   * # Parameters
   *
   * - `peer_pk`: The peer's public keys
   * - `our_pk`: Our public keys
   * - `our_sk`: Our secret keys
   * - `user_data`: Arbitrary user data to include in the announcement (can be empty)
   *
   * # Security Warning
   *
   * **The user_data in announcements has reduced security compared to regular messages:**
   * - ✅ **Plausible deniability preserved**: The user_data is not cryptographically signed,
   *   so you can deny having sent specific user_data content (though you cannot deny the
   *   announcement itself).
   * - ❌ **No post-compromise secrecy**: If your long-term keys are compromised in the
   *   future, past announcements (including their user_data) can be decrypted.
   *
   * **Recommendation**: Avoid including highly sensitive information in user_data. Use it for
   * metadata like protocol version, public display names, or capability flags. Send truly
   * sensitive data through regular messages after the session is established.
   *
   * # Returns
   *
   * The announcement bytes to publish to the blockchain.
   */
  establish_outgoing_session(peer_pk: UserPublicKeys, our_pk: UserPublicKeys, our_sk: UserSecretKeys, user_data: Uint8Array): Uint8Array;
  /**
   * Feeds an incoming announcement from the blockchain.
   *
   * # Parameters
   *
   * - `announcement_bytes`: The raw announcement bytes received from the blockchain
   * - `our_pk`: Our public keys
   * - `our_sk`: Our secret keys
   *
   * # Returns
   *
   * If the announcement is valid, returns an `AnnouncementResult` containing:
   * - The announcer's public keys
   * - The timestamp when the announcement was created (milliseconds since Unix epoch)
   * - The user data embedded in the announcement
   *
   * Returns `None` if the announcement is invalid or too old.
   *
   * # Security Warning
   *
   * **The user_data in announcements has reduced security compared to regular messages:**
   * - ✅ **Plausible deniability preserved**: The user_data is not cryptographically signed,
   *   so the sender can deny having sent specific user_data content (though they cannot deny
   *   the announcement itself).
   * - ❌ **No post-compromise secrecy**: If the sender's long-term keys are compromised
   *   in the future, all past announcements (including their user_data) can be decrypted.
   *
   * **Recommendation**: Treat user_data as having limited confidentiality. Use it for
   * metadata that is not highly sensitive. Send truly sensitive information through regular
   * messages after the session is established.
   */
  feed_incoming_announcement(announcement_bytes: Uint8Array, our_pk: UserPublicKeys, our_sk: UserSecretKeys): AnnouncementResult | undefined;
  /**
   * Gets the list of message board seekers to monitor.
   */
  get_message_board_read_keys(): Array<any>;
  /**
   * Sends a message to a peer.
   */
  send_message(peer_id: Uint8Array, message_contents: Uint8Array): SendMessageOutput | undefined;
  /**
   * Processes an incoming message from the message board.
   */
  feed_incoming_message_board_read(seeker: Uint8Array, ciphertext: Uint8Array, our_sk: UserSecretKeys): ReceiveMessageOutput | undefined;
  /**
   * Gets the list of all peer IDs.
   */
  peer_list(): Array<any>;
  /**
   * Gets the session status for a peer.
   */
  peer_session_status(peer_id: Uint8Array): SessionStatus;
  /**
   * Discards a peer and all associated session state.
   */
  peer_discard(peer_id: Uint8Array): void;
  /**
   * Refreshes sessions and returns peer IDs that need keep-alive messages.
   */
  refresh(): Array<any>;
}
/**
 * User keypair containing both public and secret keys.
 */
export class UserKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Gets the public keys.
   */
  public_keys(): UserPublicKeys;
  /**
   * Gets the secret keys.
   */
  secret_keys(): UserSecretKeys;
}
/**
 * User public keys for authentication and encryption.
 */
export class UserPublicKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Derives a unique user ID from the public keys.
   */
  derive_id(): Uint8Array;
  /**
   * Serializes the public keys to bytes.
   */
  to_bytes(): Uint8Array;
  /**
   * Deserializes public keys from bytes.
   */
  static from_bytes(bytes: Uint8Array): UserPublicKeys;
  /**
   * Gets the DSA verification key bytes.
   */
  readonly dsa_verification_key: Uint8Array;
  /**
   * Gets the KEM public key bytes.
   */
  readonly kem_public_key: Uint8Array;
  /**
   * Gets the Massa public key bytes.
   */
  readonly massa_public_key: Uint8Array;
}
/**
 * User secret keys for signing and decryption.
 */
export class UserSecretKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Serializes the secret keys to bytes for secure storage.
   */
  to_bytes(): Uint8Array;
  /**
   * Deserializes secret keys from bytes.
   */
  static from_bytes(bytes: Uint8Array): UserSecretKeys;
  /**
   * Gets the DSA signing key bytes.
   */
  readonly dsa_signing_key: Uint8Array;
  /**
   * Gets the KEM secret key bytes.
   */
  readonly kem_secret_key: Uint8Array;
  /**
   * Gets only the Massa secret key bytes
   */
  readonly massa_secret_key: Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_sessionconfig_free: (a: number, b: number) => void;
  readonly sessionconfig_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => number;
  readonly sessionconfig_new_default: () => number;
  readonly __wbg_userpublickeys_free: (a: number, b: number) => void;
  readonly userpublickeys_derive_id: (a: number) => [number, number];
  readonly userpublickeys_dsa_verification_key: (a: number) => [number, number];
  readonly userpublickeys_kem_public_key: (a: number) => [number, number];
  readonly userpublickeys_massa_public_key: (a: number) => [number, number];
  readonly userpublickeys_to_bytes: (a: number) => [number, number, number, number];
  readonly userpublickeys_from_bytes: (a: number, b: number) => [number, number, number];
  readonly __wbg_usersecretkeys_free: (a: number, b: number) => void;
  readonly usersecretkeys_to_bytes: (a: number) => [number, number, number, number];
  readonly usersecretkeys_from_bytes: (a: number, b: number) => [number, number, number];
  readonly usersecretkeys_dsa_signing_key: (a: number) => [number, number];
  readonly usersecretkeys_kem_secret_key: (a: number) => [number, number];
  readonly usersecretkeys_massa_secret_key: (a: number) => [number, number];
  readonly __wbg_userkeys_free: (a: number, b: number) => void;
  readonly userkeys_public_keys: (a: number) => [number, number, number];
  readonly userkeys_secret_keys: (a: number) => [number, number, number];
  readonly generate_user_keys: (a: number, b: number) => [number, number, number];
  readonly __wbg_encryptionkey_free: (a: number, b: number) => void;
  readonly encryptionkey_generate: () => number;
  readonly encryptionkey_from_seed: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly encryptionkey_from_bytes: (a: number, b: number) => [number, number, number];
  readonly encryptionkey_to_bytes: (a: number) => [number, number];
  readonly __wbg_nonce_free: (a: number, b: number) => void;
  readonly nonce_generate: () => number;
  readonly nonce_from_bytes: (a: number, b: number) => [number, number, number];
  readonly nonce_to_bytes: (a: number) => [number, number];
  readonly aead_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly aead_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly __wbg_sendmessageoutput_free: (a: number, b: number) => void;
  readonly sendmessageoutput_seeker: (a: number) => [number, number];
  readonly sendmessageoutput_data: (a: number) => [number, number];
  readonly __wbg_receivemessageoutput_free: (a: number, b: number) => void;
  readonly __wbg_announcementresult_free: (a: number, b: number) => void;
  readonly announcementresult_announcer_public_keys: (a: number) => number;
  readonly announcementresult_timestamp: (a: number) => number;
  readonly announcementresult_user_data: (a: number) => [number, number];
  readonly receivemessageoutput_message: (a: number) => [number, number];
  readonly receivemessageoutput_timestamp: (a: number) => number;
  readonly receivemessageoutput_acknowledged_seekers: (a: number) => any;
  readonly receivemessageoutput_user_id: (a: number) => [number, number];
  readonly __wbg_sessionmanagerwrapper_free: (a: number, b: number) => void;
  readonly sessionmanagerwrapper_new: (a: number) => number;
  readonly sessionmanagerwrapper_from_encrypted_blob: (a: number, b: number, c: number) => [number, number, number];
  readonly sessionmanagerwrapper_to_encrypted_blob: (a: number, b: number) => [number, number, number, number];
  readonly sessionmanagerwrapper_establish_outgoing_session: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly sessionmanagerwrapper_feed_incoming_announcement: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly sessionmanagerwrapper_get_message_board_read_keys: (a: number) => any;
  readonly sessionmanagerwrapper_send_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly sessionmanagerwrapper_feed_incoming_message_board_read: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly sessionmanagerwrapper_peer_list: (a: number) => any;
  readonly sessionmanagerwrapper_peer_session_status: (a: number, b: number, c: number) => [number, number, number];
  readonly sessionmanagerwrapper_peer_discard: (a: number, b: number, c: number) => [number, number];
  readonly sessionmanagerwrapper_refresh: (a: number) => any;
  readonly start: () => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
