/** Secure storage block size in bytes — must match the Rust BLOCK_SIZE constant. */
export const BLOCK_SIZE = 65536;

/** Number of session slots — must match the Rust SESSION_COUNT constant. */
export const SESSION_COUNT = 5;

/**
 * Usable payload bytes per block after AEAD framing.
 * = PQ_MSG_SIZE (15872) - AEAD_NONCE_SIZE (16) - AEAD_TAG_SIZE (16) = 15840
 * Must match the Rust PLAINTEXT_SIZE constant.
 */
export const PLAINTEXT_SIZE = 15840;
