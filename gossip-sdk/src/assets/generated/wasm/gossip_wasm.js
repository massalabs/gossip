let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_2.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

export function start() {
    wasm.start();
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_2.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * Generates user keys from a passphrase using password-based key derivation.
 * @param {string} passphrase
 * @returns {UserKeys}
 */
export function generate_user_keys(passphrase) {
    const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generate_user_keys(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return UserKeys.__wrap(ret[0]);
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}
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
 * @param {EncryptionKey} key
 * @param {Nonce} nonce
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} aad
 * @returns {Uint8Array}
 */
export function aead_encrypt(key, nonce, plaintext, aad) {
    _assertClass(key, EncryptionKey);
    _assertClass(nonce, Nonce);
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.aead_encrypt(key.__wbg_ptr, nonce.__wbg_ptr, ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

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
 * @param {EncryptionKey} key
 * @param {Nonce} nonce
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} aad
 * @returns {Uint8Array | undefined}
 */
export function aead_decrypt(key, nonce, ciphertext, aad) {
    _assertClass(key, EncryptionKey);
    _assertClass(nonce, Nonce);
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.aead_decrypt(key.__wbg_ptr, nonce.__wbg_ptr, ptr0, len0, ptr1, len1);
    let v3;
    if (ret[0] !== 0) {
        v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v3;
}

/**
 * Session status indicating the state of a peer session.
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6}
 */
export const SessionStatus = Object.freeze({
    Active: 0, "0": "Active",
    UnknownPeer: 1, "1": "UnknownPeer",
    NoSession: 2, "2": "NoSession",
    PeerRequested: 3, "3": "PeerRequested",
    SelfRequested: 4, "4": "SelfRequested",
    Killed: 5, "5": "Killed",
    Saturated: 6, "6": "Saturated",
});

const AnnouncementResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_announcementresult_free(ptr >>> 0, 1));
/**
 * Result from feeding an incoming announcement.
 */
export class AnnouncementResult {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AnnouncementResult.prototype);
        obj.__wbg_ptr = ptr;
        AnnouncementResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AnnouncementResultFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_announcementresult_free(ptr, 0);
    }
    /**
     * Gets the announcer's public keys.
     * @returns {UserPublicKeys}
     */
    get announcer_public_keys() {
        const ret = wasm.announcementresult_announcer_public_keys(this.__wbg_ptr);
        return UserPublicKeys.__wrap(ret);
    }
    /**
     * Gets the announcement timestamp in milliseconds since Unix epoch.
     * @returns {number}
     */
    get timestamp() {
        const ret = wasm.announcementresult_timestamp(this.__wbg_ptr);
        return ret;
    }
    /**
     * Gets the user data embedded in the announcement.
     * @returns {Uint8Array}
     */
    get user_data() {
        const ret = wasm.announcementresult_user_data(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) AnnouncementResult.prototype[Symbol.dispose] = AnnouncementResult.prototype.free;

const EncryptionKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptionkey_free(ptr >>> 0, 1));
/**
 * Encryption key for AEAD operations (AES-256-SIV).
 *
 * AES-256-SIV uses a 64-byte (512-bit) key: two 256-bit keys for encryption and MAC.
 */
export class EncryptionKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncryptionKey.prototype);
        obj.__wbg_ptr = ptr;
        EncryptionKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptionKeyFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptionkey_free(ptr, 0);
    }
    /**
     * Generates a new random encryption key (64 bytes).
     * @returns {EncryptionKey}
     */
    static generate() {
        const ret = wasm.encryptionkey_generate();
        return EncryptionKey.__wrap(ret);
    }
    /**
     * Generates a deterministic encryption key (64 bytes) from a seed and salt.
     *
     * Uses Argon2id via `crypto_password_kdf` to derive a 64-byte key suitable for
     * AES-256-SIV (which requires 64 bytes: 2×256-bit keys).
     *
     * - `seed`: application-provided seed string (treat like a password)
     * - `salt`: unique, random salt (minimum 8 bytes, recommended 16+ bytes)
     * @param {string} seed
     * @param {Uint8Array} salt
     * @returns {EncryptionKey}
     */
    static from_seed(seed, salt) {
        const ptr0 = passStringToWasm0(seed, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(salt, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.encryptionkey_from_seed(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EncryptionKey.__wrap(ret[0]);
    }
    /**
     * Creates an encryption key from raw bytes (must be 64 bytes).
     * @param {Uint8Array} bytes
     * @returns {EncryptionKey}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encryptionkey_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return EncryptionKey.__wrap(ret[0]);
    }
    /**
     * Gets the raw bytes of the encryption key.
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.encryptionkey_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) EncryptionKey.prototype[Symbol.dispose] = EncryptionKey.prototype.free;

const NonceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_nonce_free(ptr >>> 0, 1));
/**
 * Nonce for AEAD operations (AES-256-SIV).
 *
 * AES-256-SIV uses a 16-byte (128-bit) nonce. The nonce should be unique
 * per encryption for maximum security, though SIV mode is nonce-misuse resistant.
 */
export class Nonce {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Nonce.prototype);
        obj.__wbg_ptr = ptr;
        NonceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NonceFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_nonce_free(ptr, 0);
    }
    /**
     * Generates a new random nonce (16 bytes).
     * @returns {Nonce}
     */
    static generate() {
        const ret = wasm.nonce_generate();
        return Nonce.__wrap(ret);
    }
    /**
     * Creates a nonce from raw bytes (must be 16 bytes).
     * @param {Uint8Array} bytes
     * @returns {Nonce}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.nonce_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Nonce.__wrap(ret[0]);
    }
    /**
     * Gets the raw bytes of the nonce.
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.nonce_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Nonce.prototype[Symbol.dispose] = Nonce.prototype.free;

const ReceiveMessageOutputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_receivemessageoutput_free(ptr >>> 0, 1));
/**
 * Output from receiving a message.
 */
export class ReceiveMessageOutput {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ReceiveMessageOutput.prototype);
        obj.__wbg_ptr = ptr;
        ReceiveMessageOutputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ReceiveMessageOutputFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_receivemessageoutput_free(ptr, 0);
    }
    /**
     * Gets the received message contents.
     * @returns {Uint8Array}
     */
    get message() {
        const ret = wasm.receivemessageoutput_message(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the message timestamp (milliseconds since Unix epoch).
     * @returns {number}
     */
    get timestamp() {
        const ret = wasm.receivemessageoutput_timestamp(this.__wbg_ptr);
        return ret;
    }
    /**
     * Gets the list of newly acknowledged seekers.
     * @returns {Array<any>}
     */
    get acknowledged_seekers() {
        const ret = wasm.receivemessageoutput_acknowledged_seekers(this.__wbg_ptr);
        return ret;
    }
    /**
     * Gets the sender's user id (32 bytes).
     * @returns {Uint8Array}
     */
    get user_id() {
        const ret = wasm.receivemessageoutput_user_id(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ReceiveMessageOutput.prototype[Symbol.dispose] = ReceiveMessageOutput.prototype.free;

const SendMessageOutputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sendmessageoutput_free(ptr >>> 0, 1));
/**
 * Output from sending a message.
 */
export class SendMessageOutput {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SendMessageOutput.prototype);
        obj.__wbg_ptr = ptr;
        SendMessageOutputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SendMessageOutputFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sendmessageoutput_free(ptr, 0);
    }
    /**
     * Gets the seeker (identifier for message board lookup).
     * @returns {Uint8Array}
     */
    get seeker() {
        const ret = wasm.sendmessageoutput_seeker(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the encrypted message data.
     * @returns {Uint8Array}
     */
    get data() {
        const ret = wasm.sendmessageoutput_data(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) SendMessageOutput.prototype[Symbol.dispose] = SendMessageOutput.prototype.free;

const SessionConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionconfig_free(ptr >>> 0, 1));
/**
 * Session manager configuration for controlling session behavior.
 */
export class SessionConfig {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SessionConfig.prototype);
        obj.__wbg_ptr = ptr;
        SessionConfigFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionConfigFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionconfig_free(ptr, 0);
    }
    /**
     * Creates a new session configuration with the given parameters.
     * @param {number} max_incoming_announcement_age_millis
     * @param {number} max_incoming_announcement_future_millis
     * @param {number} max_incoming_message_age_millis
     * @param {number} max_incoming_message_future_millis
     * @param {number} max_session_inactivity_millis
     * @param {number} keep_alive_interval_millis
     * @param {bigint} max_session_lag_length
     */
    constructor(max_incoming_announcement_age_millis, max_incoming_announcement_future_millis, max_incoming_message_age_millis, max_incoming_message_future_millis, max_session_inactivity_millis, keep_alive_interval_millis, max_session_lag_length) {
        const ret = wasm.sessionconfig_new(max_incoming_announcement_age_millis, max_incoming_announcement_future_millis, max_incoming_message_age_millis, max_incoming_message_future_millis, max_session_inactivity_millis, keep_alive_interval_millis, max_session_lag_length);
        this.__wbg_ptr = ret >>> 0;
        SessionConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Creates a default configuration with sensible defaults:
     * - Announcement age: 1 week
     * - Announcement future: 1 minute
     * - Message age: 1 week
     * - Message future: 1 minute
     * - Session inactivity: 1 week
     * - Keep-alive interval: 1 day
     * - Max lag: 10000 messages
     * @returns {SessionConfig}
     */
    static new_default() {
        const ret = wasm.sessionconfig_new_default();
        return SessionConfig.__wrap(ret);
    }
}
if (Symbol.dispose) SessionConfig.prototype[Symbol.dispose] = SessionConfig.prototype.free;

const SessionManagerWrapperFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionmanagerwrapper_free(ptr >>> 0, 1));
/**
 * Session manager wrapper for WebAssembly.
 */
export class SessionManagerWrapper {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SessionManagerWrapper.prototype);
        obj.__wbg_ptr = ptr;
        SessionManagerWrapperFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionManagerWrapperFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionmanagerwrapper_free(ptr, 0);
    }
    /**
     * Creates a new session manager with the given configuration.
     * @param {SessionConfig} config
     */
    constructor(config) {
        _assertClass(config, SessionConfig);
        var ptr0 = config.__destroy_into_raw();
        const ret = wasm.sessionmanagerwrapper_new(ptr0);
        this.__wbg_ptr = ret >>> 0;
        SessionManagerWrapperFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Deserializes a session manager from an encrypted blob.
     * @param {Uint8Array} encrypted_blob
     * @param {EncryptionKey} key
     * @returns {SessionManagerWrapper}
     */
    static from_encrypted_blob(encrypted_blob, key) {
        const ptr0 = passArray8ToWasm0(encrypted_blob, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(key, EncryptionKey);
        const ret = wasm.sessionmanagerwrapper_from_encrypted_blob(ptr0, len0, key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SessionManagerWrapper.__wrap(ret[0]);
    }
    /**
     * Serializes and encrypts the session manager into a blob.
     * @param {EncryptionKey} key
     * @returns {Uint8Array}
     */
    to_encrypted_blob(key) {
        _assertClass(key, EncryptionKey);
        const ret = wasm.sessionmanagerwrapper_to_encrypted_blob(this.__wbg_ptr, key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
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
     * @param {UserPublicKeys} peer_pk
     * @param {UserPublicKeys} our_pk
     * @param {UserSecretKeys} our_sk
     * @param {Uint8Array} user_data
     * @returns {Uint8Array}
     */
    establish_outgoing_session(peer_pk, our_pk, our_sk, user_data) {
        _assertClass(peer_pk, UserPublicKeys);
        _assertClass(our_pk, UserPublicKeys);
        _assertClass(our_sk, UserSecretKeys);
        const ptr0 = passArray8ToWasm0(user_data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmanagerwrapper_establish_outgoing_session(this.__wbg_ptr, peer_pk.__wbg_ptr, our_pk.__wbg_ptr, our_sk.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
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
     * @param {Uint8Array} announcement_bytes
     * @param {UserPublicKeys} our_pk
     * @param {UserSecretKeys} our_sk
     * @returns {AnnouncementResult | undefined}
     */
    feed_incoming_announcement(announcement_bytes, our_pk, our_sk) {
        const ptr0 = passArray8ToWasm0(announcement_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(our_pk, UserPublicKeys);
        _assertClass(our_sk, UserSecretKeys);
        const ret = wasm.sessionmanagerwrapper_feed_incoming_announcement(this.__wbg_ptr, ptr0, len0, our_pk.__wbg_ptr, our_sk.__wbg_ptr);
        return ret === 0 ? undefined : AnnouncementResult.__wrap(ret);
    }
    /**
     * Gets the list of message board seekers to monitor.
     * @returns {Array<any>}
     */
    get_message_board_read_keys() {
        const ret = wasm.sessionmanagerwrapper_get_message_board_read_keys(this.__wbg_ptr);
        return ret;
    }
    /**
     * Sends a message to a peer.
     * @param {Uint8Array} peer_id
     * @param {Uint8Array} message_contents
     * @returns {SendMessageOutput | undefined}
     */
    send_message(peer_id, message_contents) {
        const ptr0 = passArray8ToWasm0(peer_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(message_contents, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmanagerwrapper_send_message(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : SendMessageOutput.__wrap(ret[0]);
    }
    /**
     * Processes an incoming message from the message board.
     * @param {Uint8Array} seeker
     * @param {Uint8Array} ciphertext
     * @param {UserSecretKeys} our_sk
     * @returns {ReceiveMessageOutput | undefined}
     */
    feed_incoming_message_board_read(seeker, ciphertext, our_sk) {
        const ptr0 = passArray8ToWasm0(seeker, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(our_sk, UserSecretKeys);
        const ret = wasm.sessionmanagerwrapper_feed_incoming_message_board_read(this.__wbg_ptr, ptr0, len0, ptr1, len1, our_sk.__wbg_ptr);
        return ret === 0 ? undefined : ReceiveMessageOutput.__wrap(ret);
    }
    /**
     * Gets the list of all peer IDs.
     * @returns {Array<any>}
     */
    peer_list() {
        const ret = wasm.sessionmanagerwrapper_peer_list(this.__wbg_ptr);
        return ret;
    }
    /**
     * Gets the session status for a peer.
     * @param {Uint8Array} peer_id
     * @returns {SessionStatus}
     */
    peer_session_status(peer_id) {
        const ptr0 = passArray8ToWasm0(peer_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmanagerwrapper_peer_session_status(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Discards a peer and all associated session state.
     * @param {Uint8Array} peer_id
     */
    peer_discard(peer_id) {
        const ptr0 = passArray8ToWasm0(peer_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmanagerwrapper_peer_discard(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Refreshes sessions and returns peer IDs that need keep-alive messages.
     * @returns {Array<any>}
     */
    refresh() {
        const ret = wasm.sessionmanagerwrapper_refresh(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SessionManagerWrapper.prototype[Symbol.dispose] = SessionManagerWrapper.prototype.free;

const UserKeysFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_userkeys_free(ptr >>> 0, 1));
/**
 * User keypair containing both public and secret keys.
 */
export class UserKeys {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UserKeys.prototype);
        obj.__wbg_ptr = ptr;
        UserKeysFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UserKeysFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_userkeys_free(ptr, 0);
    }
    /**
     * Gets the public keys.
     * @returns {UserPublicKeys}
     */
    public_keys() {
        const ret = wasm.userkeys_public_keys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UserPublicKeys.__wrap(ret[0]);
    }
    /**
     * Gets the secret keys.
     * @returns {UserSecretKeys}
     */
    secret_keys() {
        const ret = wasm.userkeys_secret_keys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UserSecretKeys.__wrap(ret[0]);
    }
}
if (Symbol.dispose) UserKeys.prototype[Symbol.dispose] = UserKeys.prototype.free;

const UserPublicKeysFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_userpublickeys_free(ptr >>> 0, 1));
/**
 * User public keys for authentication and encryption.
 */
export class UserPublicKeys {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UserPublicKeys.prototype);
        obj.__wbg_ptr = ptr;
        UserPublicKeysFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UserPublicKeysFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_userpublickeys_free(ptr, 0);
    }
    /**
     * Derives a unique user ID from the public keys.
     * @returns {Uint8Array}
     */
    derive_id() {
        const ret = wasm.userpublickeys_derive_id(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the DSA verification key bytes.
     * @returns {Uint8Array}
     */
    get dsa_verification_key() {
        const ret = wasm.userpublickeys_dsa_verification_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the KEM public key bytes.
     * @returns {Uint8Array}
     */
    get kem_public_key() {
        const ret = wasm.userpublickeys_kem_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the Massa public key bytes.
     * @returns {Uint8Array}
     */
    get massa_public_key() {
        const ret = wasm.userpublickeys_massa_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Serializes the public keys to bytes.
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.userpublickeys_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Deserializes public keys from bytes.
     * @param {Uint8Array} bytes
     * @returns {UserPublicKeys}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.userpublickeys_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UserPublicKeys.__wrap(ret[0]);
    }
}
if (Symbol.dispose) UserPublicKeys.prototype[Symbol.dispose] = UserPublicKeys.prototype.free;

const UserSecretKeysFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_usersecretkeys_free(ptr >>> 0, 1));
/**
 * User secret keys for signing and decryption.
 */
export class UserSecretKeys {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UserSecretKeys.prototype);
        obj.__wbg_ptr = ptr;
        UserSecretKeysFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UserSecretKeysFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_usersecretkeys_free(ptr, 0);
    }
    /**
     * Serializes the secret keys to bytes for secure storage.
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.usersecretkeys_to_bytes(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Deserializes secret keys from bytes.
     * @param {Uint8Array} bytes
     * @returns {UserSecretKeys}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.usersecretkeys_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UserSecretKeys.__wrap(ret[0]);
    }
    /**
     * Gets the DSA signing key bytes.
     * @returns {Uint8Array}
     */
    get dsa_signing_key() {
        const ret = wasm.usersecretkeys_dsa_signing_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets the KEM secret key bytes.
     * @returns {Uint8Array}
     */
    get kem_secret_key() {
        const ret = wasm.usersecretkeys_kem_secret_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Gets only the Massa secret key bytes
     * @returns {Uint8Array}
     */
    get massa_secret_key() {
        const ret = wasm.usersecretkeys_massa_secret_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) UserSecretKeys.prototype[Symbol.dispose] = UserSecretKeys.prototype.free;

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_call_13410aac570ffff7 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_a5400b25a865cfd8 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
        const ret = arg0.crypto;
        return ret;
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
    }, arguments) };
    imports.wbg.__wbg_length_6bb7e81f9d7713e4 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
        const ret = arg0.msCrypto;
        return ret;
    };
    imports.wbg.__wbg_new_1f3a344cf3123716 = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_newfromslice_074c56947bd43469 = function(arg0, arg1) {
        const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_newnoargs_254190557c45b4ec = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_newwithlength_a167dcc7aaa3ba77 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_node_905d3e251edff8a2 = function(arg0) {
        const ret = arg0.node;
        return ret;
    };
    imports.wbg.__wbg_now_1e80617bcee43265 = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
        const ret = arg0.process;
        return ret;
    };
    imports.wbg.__wbg_prototypesetcall_3d4a26c1ed734349 = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_push_330b2eb93e4e1212 = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
    }, arguments) };
    imports.wbg.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
        const ret = module.require;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_8921f820c2ce3f12 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_f0a4409105898184 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_995b214ae681ff99 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_cde3890479c675ea = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_subarray_70fd07feefe14294 = function(arg0, arg1, arg2) {
        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_versions_c01dfd4722a88165 = function(arg0) {
        const ret = arg0.versions;
        return ret;
    };
    imports.wbg.__wbg_wbindgenisfunction_8cee7dce3725ae74 = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbg_wbindgenisobject_307a53c6bd97fbf8 = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg_wbindgenisstring_d4fa939789f003b0 = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbg_wbindgenisundefined_c4b71d073b92f3c5 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg_wbindgenthrow_451ec1a8469d7eb6 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
        const ret = getArrayU8FromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_2;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('gossip_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
