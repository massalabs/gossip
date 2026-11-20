/* tslint:disable */
/* eslint-disable */
export function start(): void;
/**
 * Generates user keys from a passphrase.
 *
 * Derives all gossip keys (DSA, KEM, Massa, EVM) in a single WASM call so
 * the passphrase crosses the JS boundary only once.
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
 * The largest group plaintext, in bytes (§13.10).
 */
export function group_max_plaintext_bytes(): number;
/**
 * The largest text of a message version, in UTF-8 bytes: a text body, or the content of a
 * forward of text. A longer one is refused by the engine and by every receiver.
 */
export function group_max_text_bytes(): number;
/**
 * The largest metadata of a message version, in bytes as [`group_metadata_bytes`] counts.
 */
export function group_max_metadata_bytes(): number;
/**
 * The size of message metadata, given as `publish_message` takes it (a list of
 * `[name, hex]` pairs in JSON): its encoded size, every entry's framing included.
 */
export function group_metadata_bytes(metadata: string): number;
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
 * Announcement for a peer, with the board entry that carries it to a peer we
 * already exchanged announcements with.
 */
export class AddressedAnnouncement {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The announcement bytes to post to the announcement board.
   */
  readonly announcement: Uint8Array;
  /**
   * Signed entry to post at `mailbox_seeker` like a message, if any.
   */
  readonly mailbox_data: Uint8Array | undefined;
  /**
   * Seeker of the board entry carrying the announcement, if any.
   */
  readonly mailbox_seeker: Uint8Array | undefined;
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
   * Creates an encryption key from raw bytes (must be 64 bytes).
   */
  static from_bytes(bytes: Uint8Array): EncryptionKey;
  /**
   * Generates a new random encryption key (64 bytes).
   */
  static generate(): EncryptionKey;
  /**
   * Gets the raw bytes of the encryption key.
   */
  to_bytes(): Uint8Array;
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
}
/**
 * The group engine of one identity.
 */
export class GroupsNode {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  handed_off(handle: number, now: number): void;
  is_current(handle: number, now: number): boolean;
  /**
   * Adds the `UserPublicKeys` bytes of a contact or a session peer to the key cache.
   * Returns its GossipID.
   */
  learn_keys(keys: Uint8Array, now: number): Uint8Array;
  /**
   * `edit`: `{"body":…|null,"author":hex|null,"created_at":…|null,
   * "last_modified_at":…|null,"metadata":…|null,"edited":bool|null}`; `metadata` is a
   * patch as for `publish_edit`, `null` keeping everything.
   */
  local_edit(epoch: Uint8Array, sync_obj_id: Uint8Array, edit: string, now: number): string;
  invitations(now: number): string;
  /**
   * `choice`: `Signed`, `AskToBeKicked` or `Silent`.
   */
  leave_group(group: Uint8Array, choice: string, now: number): void;
  link_groups(a: Uint8Array, b: Uint8Array, linked: boolean, now: number): void;
  /**
   * When to call `tick` next, or `undefined`.
   */
  next_wakeup(now: number): number | undefined;
  /**
   * The plaintexts to send: an array of `{handle, to, plaintext}`.
   */
  poll_outbox(now: number): Array<any>;
  /**
   * The reference (§4.5) of a held epoch, which reply targets name.
   */
  ref_chat_id(epoch: Uint8Array): Uint8Array | undefined;
  resend_root(group: Uint8Array, now: number): void;
  /**
   * Whether a session with `peer` exists (in memory only; report it again after opening).
   */
  set_session(peer_id: Uint8Array, has_session: boolean): void;
  /**
   * `change`: `{"t":"Successor","add":[hex],"remove":[hex],"name":null|string}`,
   * `{"t":"Handover","new_owner":hex,"leave":bool,"name":…}`,
   * `{"t":"MessageTimer","timer":ms}` or `{"t":"Resolve","members":[hex],"name":…}`.
   * Returns the new epoch.
   */
  change_group(group: Uint8Array, change: string, now: number): Uint8Array;
  /**
   * Founds a group; `members` is the concatenation of their 32-byte GossipIDs. Returns
   * the group key.
   */
  create_group(name: string, members: Uint8Array, now: number): Uint8Array;
  delete_group(group: Uint8Array, now: number): void;
  /**
   * Whether `peer` is a member of a group this device holds and has accepted: a
   * connection it asks for may be opened automatically (§5.12).
   */
  is_co_member(peer_id: Uint8Array): boolean;
  local_delete(epoch: Uint8Array, sync_obj_id: Uint8Array, now: number): string;
  /**
   * An edit starts from the message's current metadata (§2.2: entries a client does not
   * know, `replyTo` included, survive it). `metadata` is a patch: `[]` or `null` keeps
   * everything, an array of `[name, hex]` sets those entries, and
   * `{"set":[[name, hex], …],"remove":[name, …]}` also removes.
   */
  publish_edit(epoch: Uint8Array, sync_obj_id: Uint8Array, body: string, metadata: string, scheduled_for: number | null | undefined, now: number): string;
  /**
   * The batches committed since the last call, oldest first: an array of
   * `{rows, removedRows, edges, removedEdges, objects, removedObjects, node, erase}`, to
   * apply in order.
   */
  take_batches(): any;
  /**
   * The changes since the last call, in JSON: `[{group, kind}]`.
   */
  take_changes(now: number): string;
  /**
   * A media message (§7.6): `mimetype` is `type/subtype` (lowercase, no parameters, at most
   * 127 bytes), `data` any bytes the event can hold; `metadata` as for `publish_message`
   * (a name or a caption). Returns `{eventId, syncObjId, merge}` in JSON.
   */
  publish_media(epoch: Uint8Array, mimetype: string, data: Uint8Array, metadata: string, now: number): string;
  dissolve_group(group: Uint8Array, must_delete: boolean, now: number): void;
  set_local_name(group: Uint8Array, name: string | null | undefined, now: number): void;
  /**
   * The targets of a `replyTo` value, in the JSON form `encode_reply_to` takes.
   */
  decode_reply_to(value: Uint8Array): string;
  /**
   * The value of the metadata key `replyTo`: `targets` is
   * `[{"ref_chat_id":hex,"sync_obj_id":hex}]`, 1 to 32 of them.
   */
  encode_reply_to(targets: string): Uint8Array;
  /**
   * The number of batches waiting to be taken.
   */
  pending_batches(): number;
  /**
   * `body`: `{"t":"Text","text":…}`,
   * `{"t":"Forward","content_type":"Text"|"Media","content":hex}` (a forwarded media
   * message is the canonical encoding of a `Media`), or
   * `{"t":"Media","media":{"mimetype":…,"data":hex}}`; a reaction goes through
   * `publish_reaction`. `metadata`: an array of `[name, hex]`. Returns
   * `{eventId, syncObjId, merge}` in JSON.
   */
  publish_message(epoch: Uint8Array, body: string, metadata: string, scheduled_for: number | null | undefined, now: number): string;
  /**
   * A group plaintext received from `from` in its one-to-one session.
   */
  handle_plaintext(from: Uint8Array, bytes: Uint8Array, now: number): void;
  peer_reconnected(peer_id: Uint8Array, now: number): void;
  publish_deletion(epoch: Uint8Array, sync_obj_id: Uint8Array, scheduled_for: number | null | undefined, now: number): string;
  /**
   * Adds (`add`) or removes this device's reaction `emoji` (1 to 64 bytes of UTF-8) to the
   * message `target` of `epoch`, the target's own epoch (§7.6). Returns
   * `{eventId, syncObjId, merge}` in JSON; `syncObjId` is the reaction's.
   */
  publish_reaction(epoch: Uint8Array, target: Uint8Array, emoji: string, add: boolean, now: number): string;
  accept_invitation(epoch: Uint8Array, now: number): Uint8Array;
  /**
   * The accepted contacts declared, in JSON: `["<peer hex>", …]`.
   */
  accepted_contacts(): string;
  /**
   * As `create_group`, for an automatic group of this device and the one other member
   * (§5.12): `migrate_from = 0` both for a migration of an earlier conversation and for the
   * chat founded after an accepted contact request; `undefined` for "New group". Returns
   * the group kept: the peer's own creation, when it is held and its owner sorts first
   * ("two creations at once").
   */
  create_group_with(name: string, members: Uint8Array, migrate_from: number | null | undefined, now: number): Uint8Array;
  /**
   * Whether this device holds a direct chat with `peer` (an automatic group of the two,
   * however it grew since): a later creation from it is then an ordinary invitation.
   */
  holds_direct_chat(peer_id: Uint8Array): boolean;
  scan_shared_chats(peer_id: Uint8Array, now: number): void;
  decline_invitation(epoch: Uint8Array, choice: string, now: number): void;
  lookup_sync_object(epoch: Uint8Array, sync_obj_id: Uint8Array, now: number): void;
  /**
   * The results of the sync-object lookups completed since the last call, in JSON:
   * `[{epoch, syncObjId, found}]`, `found` the event ID received or `null`. Removing them
   * is a committed operation: take the batches after it.
   */
  take_lookup_results(now: number): string;
  /**
   * The consents not used yet, in JSON: `[["<peer hex>", "<expires at>"], …]`.
   */
  direct_chat_consents(): string;
  /**
   * Declares (`accepted`) or clears that `peer` is a contact the user accepted (§13.8): only
   * such a peer gets a version notice for a plaintext of a later wire version. Call it when
   * the user accepts a contact, when a contact is removed, and at open for every accepted
   * contact.
   */
  set_accepted_contact(peer_id: Uint8Array, accepted: boolean, now: number): void;
  /**
   * Among `candidates` (concatenated 32-byte GossipIDs), those whose automatic connection
   * may be revoked: no group shared, no held epoch lists them (§5.12). Concatenated.
   */
  connections_to_revoke(candidates: Uint8Array): Uint8Array;
  /**
   * The earlier conversations declared, in JSON: `[["<peer hex>", "<version>"], …]` (integers as decimal strings, as every view).
   */
  earlier_conversations(): string;
  /**
   * Gives (`consent`) or withdraws the consent to the group of two `peer` creates after
   * its contact request was accepted (§5.12): one-shot, for 14 days.
   */
  consent_to_direct_chat(peer_id: Uint8Array, consent: boolean, now: number): void;
  /**
   * As `create_group_with`, with the message timer of the group in milliseconds (§7.7):
   * each message is deleted on every device at its creation date plus the timer; 0 keeps
   * messages forever. The owner changes it later with `change_group`
   * (`{"t":"MessageTimer","timer":ms}`).
   */
  create_group_with_timer(name: string, members: Uint8Array, migrate_from: number | null | undefined, message_timer: number, now: number): Uint8Array;
  /**
   * The members of accepted groups with which no session is reported (`set_session`):
   * the connections to open. Concatenated 32-byte GossipIDs.
   */
  peers_wanting_connection(): Uint8Array;
  /**
   * Records (`held`) or clears that this device holds an earlier conversation of format
   * `version` with `peer` (§5.12, condition 3): stored, until cleared.
   */
  set_earlier_conversation(peer_id: Uint8Array, version: number, held: boolean, now: number): void;
  /**
   * This identity's GossipID.
   */
  me(): Uint8Array;
  /**
   * The verified keys held for `id`, if any.
   */
  keys(id: Uint8Array): Uint8Array | undefined;
  /**
   * Opens the engine of the identity from a snapshot of its stored records
   * (`{rows, edges, objects, node}`, see `take_batches`; empty arrays for a new account).
   * Only the ML-DSA signing key is copied out of the secret keys; the copy is erased
   * when this object is freed. Fails with `groups:undecodable: …` when a stored record
   * cannot be decoded (one written by an earlier build).
   */
  static open(public_keys: UserPublicKeys, secret_keys: UserSecretKeys, snapshot: any): GroupsNode;
  tick(now: number): void;
  /**
   * The root of a held epoch in JSON: `{epoch, name, members, owner, created_at}`, or
   * `null`.
   */
  epoch(epoch: Uint8Array): string;
  /**
   * One group by any of its epochs, in JSON (`null` when unknown).
   */
  group(epoch: Uint8Array): string;
  /**
   * The media message `sync_obj_id` of `epoch` with its data: `{mimetype, data}` (`data`
   * a `Uint8Array`), or `null` when the message is not visible or holds no media.
   */
  media(epoch: Uint8Array, sync_obj_id: Uint8Array, now: number): any;
  retry(epoch: Uint8Array, sync_obj_id: Uint8Array, now: number): string;
  /**
   * Every group, in JSON.
   */
  groups(): string;
  abandon(handle: number): void;
  /**
   * Message records found without their epoch when opening, and dropped.
   */
  orphans(): number;
  /**
   * Every record as one batch of upserts.
   */
  snapshot(): any;
  /**
   * The timeline in JSON. A message lists `reactions` as `[[author, emoji], …]`; a media
   * message (or a forwarded one) comes without its data, with `data_len`: read the data
   * with `media`.
   */
  timeline(epoch: Uint8Array, now: number): string;
  published(handle: number, now: number): void;
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
   * Creates a nonce from raw bytes (must be 16 bytes).
   */
  static from_bytes(bytes: Uint8Array): Nonce;
  /**
   * Generates a new random nonce (16 bytes).
   */
  static generate(): Nonce;
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
   * Gets the list of newly acknowledged seekers.
   */
  readonly acknowledged_seekers: Array<any>;
  /**
   * Whether the sender's timestamp is older than the configured maximum age or than
   * the previous message: authentic and in order, but possibly delayed in transit.
   */
  readonly stale: boolean;
  /**
   * Gets the received message contents.
   */
  readonly message: Uint8Array;
  /**
   * Gets the sender's user id (32 bytes).
   */
  readonly user_id: Uint8Array;
  /**
   * Gets the message timestamp (milliseconds since Unix epoch).
   */
  readonly timestamp: number;
}
/**
 * Output from sending a message.
 */
export class SendMessageOutput {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Gets the encrypted message data.
   */
  readonly data: Uint8Array;
  /**
   * Gets the seeker (identifier for message board lookup).
   */
  readonly seeker: Uint8Array;
}
/**
 * Session manager configuration for controlling session behavior.
 */
export class SessionConfig {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Creates a default configuration with sensible defaults:
   * - Announcement age: 1 week
   * - Announcement future: 1 hour
   * - Message age: 2 weeks
   * - Message future: 1 day
   * - Session inactivity: 2 weeks
   * - Keep-alive interval: 1 day
   * - Max lag: 10000 messages
   * - Max peer lag before keep-alive: 8 messages
   *
   * The clock windows allow for store-and-forward delivery: a phone that relays
   * over Bluetooth while offline has no time source, and a clock set by hand can be
   * off by a whole time zone. A message dated beyond the future window is not lost,
   * only left to be read again later; one older than the age window is delivered and
   * flagged stale. Two weeks matches the network's retention, past which a message
   * cannot be fetched anyway. Announcements keep a tighter future window because a
   * future-dated announcement blocks the sender's later, correctly dated ones.
   * Session inactivity is measured on the peer's message timestamps, so it matches
   * the message age window: a message that waited up to two weeks in transit still
   * finds its session instead of arriving after it expired.
   */
  static new_default(): SessionConfig;
  /**
   * Creates a new session configuration with the given parameters.
   */
  constructor(max_incoming_announcement_age_millis: number, max_incoming_announcement_future_millis: number, max_incoming_message_age_millis: number, max_incoming_message_future_millis: number, max_session_inactivity_millis: number, keep_alive_interval_millis: number, max_session_lag_length: bigint, max_keep_alive_peer_lag_length: bigint);
}
/**
 * Session manager wrapper for WebAssembly.
 */
export class SessionManagerWrapper {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Replaces the configuration, which a manager restored from a blob otherwise keeps
   * from when it was created.
   */
  set_config(config: SessionConfig): void;
  peer_discard(peer_id: Uint8Array): void;
  /**
   * Sends a message to a peer.
   */
  send_message(peer_id: Uint8Array, message_contents: Uint8Array): SendMessageOutput | undefined;
  /**
   * Serializes and encrypts the session manager into a blob.
   */
  to_encrypted_blob(key: EncryptionKey): Uint8Array;
  /**
   * Deserializes a session manager from an encrypted blob.
   */
  static from_encrypted_blob(encrypted_blob: Uint8Array, key: EncryptionKey): SessionManagerWrapper;
  /**
   * Gets the session status for a peer.
   */
  peer_session_status(peer_id: Uint8Array): SessionStatus;
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
   *
   * Each seeker is materialised as a JS-owned Uint8Array via
   * `new_with_length` + `copy_from`. `Uint8Array::from(&[u8])` in older
   * js-sys returns an array whose buffer view sits over wasm linear
   * memory; subsequent wasm calls that grow the heap detach those
   * views, and the JS-side `SEEKERS_UPDATED` listener crashes with
   * "Cannot perform values on a detached ArrayBuffer". The
   * new-with-length path allocates a JS-side ArrayBuffer up front,
   * then copies — the result is decoupled from wasm memory.
   */
  get_message_board_read_keys(): Array<any>;
  /**
   * Gets the seekers where peers would post their next announcement to us
   * (JS-owned Uint8Arrays, see `get_message_board_read_keys`).
   */
  get_reannouncement_mailbox_keys(): Array<any>;
  /**
   * Processes an incoming message from the message board.
   *
   * Each acknowledged seeker is materialised as a JS-owned Uint8Array
   * (see `get_message_board_read_keys` for the rationale — same risk
   * of detached views over wasm linear memory if the heap grows
   * before the JS side reads the buffer).
   */
  feed_incoming_message_board_read(seeker: Uint8Array, ciphertext: Uint8Array, our_sk: UserSecretKeys): ReceiveMessageOutput | undefined;
  /**
   * Gets the seekers of the messages after the next one from each peer, for
   * transports that request messages ahead of time (JS-owned Uint8Arrays, see
   * `get_message_board_read_keys`).
   */
  get_message_board_lookahead_keys(): Array<any>;
  /**
   * Returns the announcement carried by an entry read at a re-announcement
   * mailbox seeker, if it is signed by the seeker key and decrypts; feed it to
   * `feed_incoming_announcement`.
   */
  open_reannouncement_mailbox_read(seeker: Uint8Array, data: Uint8Array): Uint8Array | undefined;
  /**
   * Same as `establish_outgoing_session`, also returning the board entry that
   * carries the announcement to a peer we already exchanged announcements with.
   */
  establish_outgoing_session_addressed(peer_pk: UserPublicKeys, our_pk: UserPublicKeys, our_sk: UserSecretKeys, user_data: Uint8Array): AddressedAnnouncement;
  /**
   * Creates a new session manager with the given configuration.
   */
  constructor(config: SessionConfig);
  /**
   * Discards a peer and all associated session state.
   * Timestamp (milliseconds) of the latest announcement accepted from a peer, if
   * any: keep it when discarding the peer to refuse replays of older ones.
   */
  peer_latest_incoming_announcement_timestamp(peer_id: Uint8Array): number | undefined;
  /**
   * Refreshes sessions and returns peer IDs that need keep-alive messages.
   *
   * JS-owned Uint8Arrays — same detached-view rationale as
   * `get_message_board_read_keys`.
   */
  refresh(): Array<any>;
  /**
   * Gets the list of all peer IDs.
   *
   * JS-owned Uint8Arrays — same detached-view rationale as
   * `get_message_board_read_keys`.
   */
  peer_list(): Array<any>;
}
/**
 * User keypair containing both public and secret keys.
 */
export class UserKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * EIP-55 checksummed EVM address (0x…) derived from the EVM public key.
   */
  evm_address(): string;
  /**
   * Gets the public keys.
   */
  public_keys(): UserPublicKeys;
  /**
   * Gets the secret keys.
   */
  secret_keys(): UserSecretKeys;
  /**
   * Massa address (AU…) derived from the Massa public key.
   */
  massa_address(): string;
}
/**
 * User public keys for authentication and encryption.
 */
export class UserPublicKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Deserializes public keys from bytes.
   */
  static from_bytes(bytes: Uint8Array): UserPublicKeys;
  /**
   * Serializes the public keys to bytes.
   */
  to_bytes(): Uint8Array;
  /**
   * Derives a unique user ID from the public keys.
   */
  derive_id(): Uint8Array;
  /**
   * Gets the EVM public key bytes (compressed, secp256k1).
   */
  readonly evm_public_key: Uint8Array;
  /**
   * Gets the KEM public key bytes.
   */
  readonly kem_public_key: Uint8Array;
  /**
   * Gets the Massa public key bytes.
   */
  readonly massa_public_key: Uint8Array;
  /**
   * Gets the DSA verification key bytes.
   */
  readonly dsa_verification_key: Uint8Array;
}
/**
 * User secret keys for signing and decryption.
 */
export class UserSecretKeys {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Deserializes secret keys from bytes.
   */
  static from_bytes(bytes: Uint8Array): UserSecretKeys;
  /**
   * Serializes the secret keys to bytes for secure storage.
   */
  to_bytes(): Uint8Array;
  /**
   * Gets the EVM secret key bytes (raw 32-byte scalar).
   */
  readonly evm_secret_key: Uint8Array;
  /**
   * Gets the KEM secret key bytes.
   */
  readonly kem_secret_key: Uint8Array;
  /**
   * Gets the DSA signing key bytes.
   */
  readonly dsa_signing_key: Uint8Array;
  /**
   * Gets only the Massa secret key bytes
   */
  readonly massa_secret_key: Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_addressedannouncement_free: (a: number, b: number) => void;
  readonly __wbg_announcementresult_free: (a: number, b: number) => void;
  readonly __wbg_encryptionkey_free: (a: number, b: number) => void;
  readonly __wbg_nonce_free: (a: number, b: number) => void;
  readonly __wbg_receivemessageoutput_free: (a: number, b: number) => void;
  readonly __wbg_sendmessageoutput_free: (a: number, b: number) => void;
  readonly __wbg_sessionconfig_free: (a: number, b: number) => void;
  readonly __wbg_sessionmanagerwrapper_free: (a: number, b: number) => void;
  readonly __wbg_userkeys_free: (a: number, b: number) => void;
  readonly __wbg_userpublickeys_free: (a: number, b: number) => void;
  readonly __wbg_usersecretkeys_free: (a: number, b: number) => void;
  readonly addressedannouncement_announcement: (a: number) => [number, number];
  readonly addressedannouncement_mailbox_data: (a: number) => [number, number];
  readonly addressedannouncement_mailbox_seeker: (a: number) => [number, number];
  readonly aead_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly aead_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly announcementresult_announcer_public_keys: (a: number) => number;
  readonly announcementresult_timestamp: (a: number) => number;
  readonly announcementresult_user_data: (a: number) => [number, number];
  readonly encryptionkey_from_bytes: (a: number, b: number) => [number, number, number];
  readonly encryptionkey_from_seed: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly encryptionkey_generate: () => number;
  readonly encryptionkey_to_bytes: (a: number) => [number, number];
  readonly generate_user_keys: (a: number, b: number) => [number, number, number];
  readonly nonce_from_bytes: (a: number, b: number) => [number, number, number];
  readonly nonce_generate: () => number;
  readonly nonce_to_bytes: (a: number) => [number, number];
  readonly receivemessageoutput_acknowledged_seekers: (a: number) => any;
  readonly receivemessageoutput_message: (a: number) => [number, number];
  readonly receivemessageoutput_stale: (a: number) => number;
  readonly receivemessageoutput_timestamp: (a: number) => number;
  readonly receivemessageoutput_user_id: (a: number) => [number, number];
  readonly sendmessageoutput_data: (a: number) => [number, number];
  readonly sendmessageoutput_seeker: (a: number) => [number, number];
  readonly sessionconfig_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: bigint) => number;
  readonly sessionconfig_new_default: () => number;
  readonly sessionmanagerwrapper_establish_outgoing_session: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly sessionmanagerwrapper_establish_outgoing_session_addressed: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly sessionmanagerwrapper_feed_incoming_announcement: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly sessionmanagerwrapper_feed_incoming_message_board_read: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly sessionmanagerwrapper_from_encrypted_blob: (a: number, b: number, c: number) => [number, number, number];
  readonly sessionmanagerwrapper_get_message_board_lookahead_keys: (a: number) => any;
  readonly sessionmanagerwrapper_get_message_board_read_keys: (a: number) => any;
  readonly sessionmanagerwrapper_get_reannouncement_mailbox_keys: (a: number) => any;
  readonly sessionmanagerwrapper_new: (a: number) => number;
  readonly sessionmanagerwrapper_open_reannouncement_mailbox_read: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly sessionmanagerwrapper_peer_discard: (a: number, b: number, c: number) => [number, number];
  readonly sessionmanagerwrapper_peer_latest_incoming_announcement_timestamp: (a: number, b: number, c: number) => [number, number, number, number];
  readonly sessionmanagerwrapper_peer_list: (a: number) => any;
  readonly sessionmanagerwrapper_peer_session_status: (a: number, b: number, c: number) => [number, number, number];
  readonly sessionmanagerwrapper_refresh: (a: number) => any;
  readonly sessionmanagerwrapper_send_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly sessionmanagerwrapper_set_config: (a: number, b: number) => void;
  readonly sessionmanagerwrapper_to_encrypted_blob: (a: number, b: number) => [number, number, number, number];
  readonly start: () => void;
  readonly userkeys_evm_address: (a: number) => [number, number];
  readonly userkeys_massa_address: (a: number) => [number, number];
  readonly userkeys_public_keys: (a: number) => [number, number, number];
  readonly userkeys_secret_keys: (a: number) => [number, number, number];
  readonly userpublickeys_derive_id: (a: number) => [number, number];
  readonly userpublickeys_dsa_verification_key: (a: number) => [number, number];
  readonly userpublickeys_evm_public_key: (a: number) => [number, number];
  readonly userpublickeys_from_bytes: (a: number, b: number) => [number, number, number];
  readonly userpublickeys_kem_public_key: (a: number) => [number, number];
  readonly userpublickeys_massa_public_key: (a: number) => [number, number];
  readonly userpublickeys_to_bytes: (a: number) => [number, number, number, number];
  readonly usersecretkeys_dsa_signing_key: (a: number) => [number, number];
  readonly usersecretkeys_evm_secret_key: (a: number) => [number, number];
  readonly usersecretkeys_from_bytes: (a: number, b: number) => [number, number, number];
  readonly usersecretkeys_kem_secret_key: (a: number) => [number, number];
  readonly usersecretkeys_massa_secret_key: (a: number) => [number, number];
  readonly usersecretkeys_to_bytes: (a: number) => [number, number, number, number];
  readonly __wbg_groupsnode_free: (a: number, b: number) => void;
  readonly group_max_metadata_bytes: () => number;
  readonly group_max_plaintext_bytes: () => number;
  readonly group_metadata_bytes: (a: number, b: number) => [number, number, number];
  readonly groupsnode_abandon: (a: number, b: number) => void;
  readonly groupsnode_accept_invitation: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly groupsnode_accepted_contacts: (a: number) => [number, number];
  readonly groupsnode_change_group: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly groupsnode_connections_to_revoke: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_consent_to_direct_chat: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly groupsnode_create_group: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly groupsnode_create_group_with: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
  readonly groupsnode_create_group_with_timer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
  readonly groupsnode_decline_invitation: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_decode_reply_to: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_delete_group: (a: number, b: number, c: number, d: number) => [number, number];
  readonly groupsnode_direct_chat_consents: (a: number) => [number, number];
  readonly groupsnode_dissolve_group: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly groupsnode_earlier_conversations: (a: number) => [number, number];
  readonly groupsnode_encode_reply_to: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_epoch: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_groups: (a: number) => [number, number];
  readonly groupsnode_handed_off: (a: number, b: number, c: number) => [number, number];
  readonly groupsnode_handle_plaintext: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_holds_direct_chat: (a: number, b: number, c: number) => [number, number, number];
  readonly groupsnode_invitations: (a: number, b: number) => [number, number, number, number];
  readonly groupsnode_is_co_member: (a: number, b: number, c: number) => [number, number, number];
  readonly groupsnode_is_current: (a: number, b: number, c: number) => [number, number, number];
  readonly groupsnode_keys: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_learn_keys: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly groupsnode_leave_group: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_link_groups: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly groupsnode_local_delete: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly groupsnode_local_edit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
  readonly groupsnode_lookup_sync_object: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_me: (a: number) => [number, number];
  readonly groupsnode_media: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
  readonly groupsnode_next_wakeup: (a: number, b: number) => [number, number, number, number];
  readonly groupsnode_open: (a: number, b: number, c: any) => [number, number, number];
  readonly groupsnode_orphans: (a: number) => number;
  readonly groupsnode_peer_reconnected: (a: number, b: number, c: number, d: number) => [number, number];
  readonly groupsnode_peers_wanting_connection: (a: number) => [number, number];
  readonly groupsnode_pending_batches: (a: number) => number;
  readonly groupsnode_poll_outbox: (a: number, b: number) => [number, number, number];
  readonly groupsnode_publish_deletion: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
  readonly groupsnode_publish_edit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
  readonly groupsnode_publish_media: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
  readonly groupsnode_publish_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
  readonly groupsnode_publish_reaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
  readonly groupsnode_published: (a: number, b: number, c: number) => [number, number];
  readonly groupsnode_ref_chat_id: (a: number, b: number, c: number) => [number, number, number, number];
  readonly groupsnode_resend_root: (a: number, b: number, c: number, d: number) => [number, number];
  readonly groupsnode_retry: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly groupsnode_scan_shared_chats: (a: number, b: number, c: number, d: number) => [number, number];
  readonly groupsnode_set_accepted_contact: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly groupsnode_set_earlier_conversation: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_set_local_name: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly groupsnode_set_session: (a: number, b: number, c: number, d: number) => [number, number];
  readonly groupsnode_snapshot: (a: number) => [number, number, number];
  readonly groupsnode_take_batches: (a: number) => [number, number, number];
  readonly groupsnode_take_changes: (a: number, b: number) => [number, number, number, number];
  readonly groupsnode_take_lookup_results: (a: number, b: number) => [number, number, number, number];
  readonly groupsnode_tick: (a: number, b: number) => [number, number];
  readonly groupsnode_timeline: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly group_max_text_bytes: () => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
