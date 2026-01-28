//! Gossip Storage - Plausible deniability storage layer
//!
//! This crate provides a storage layer with plausible deniability for the Gossip
//! E2E encrypted chat application. It uses:
//! - Fixed-size addressing blob (2MB, 65,536 slots × 32 bytes)
//! - Variable-size data blob with Pareto padding and encrypted blocks
//! - Constant-time slot scanning (no timing attacks)
//! - Memory safety with zeroize on drop
//!
//! ## Architecture
//!
//! ```text
//! SQLite (wa-sqlite)
//!     ↓ xRead/xWrite at logical offsets
//! Custom VFS (JavaScript)
//!     ↓ readData/writeData at logical offsets
//! Rust WASM (BlockManager)
//!     ├── Allocation Table (maps logical → physical)
//!     ├── Block Cache (decrypted blocks in memory)
//!     ├── Write Buffer (pending writes before block finalization)
//!     └── Block Encryption/Decryption
//!     ↓ read_bytes/write_bytes at physical offsets
//! FileSystem (OPFS/Node)
//!     ↓
//! data.bin: [Pareto][Root Block][Pareto][Block 1][Pareto][Block 2]...
//! ```

#![deny(unsafe_code)]
#![warn(clippy::all)]

pub mod blob;
pub mod block;
pub mod block_manager;
pub mod config;
pub mod crypto;
pub mod fs;
pub mod session;

pub use blob::{
    AddressingBlob, EncryptedSlot, SlotContent,
    SLOT_COUNT, SLOT_SIZE, SLOTS_PER_SESSION, ADDRESSING_BLOB_SIZE,
    generate_pareto_padding, generate_pareto_padding_with_config,
    draw_block_size, draw_block_size_with_config,
    write_random_padding,
};
pub use config::{PaddingValues, StorageConfig};
pub use block::{
    AllocationEntry, AllocationTable, DecryptedBlock, BlockId,
    generate_block_id, ALLOCATION_ENTRY_SIZE, BLOCK_ID_SIZE, AEAD_TAG_SIZE,
};
pub use block_manager::{BlockManager, BlockError};
pub use crypto::{
    derive_master_key, derive_slot_indices, encrypt_slot, decrypt_slot,
    derive_block_key, encrypt_block, decrypt_block, encrypt_root_block, decrypt_root_block,
    unlock_session, MasterKey, SlotKey, BlockKey, SessionKeys, SessionAeadKey, UnlockResult, CryptoError,
};
pub use fs::{FileSystem, InMemoryFs, FILE_ADDRESSING, FILE_DATA};
pub use session::{Session, SessionManager, SessionState, SessionError};

#[cfg(feature = "wasm")]
mod wasm;

#[cfg(feature = "wasm")]
pub use wasm::*;
