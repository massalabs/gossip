//! The pools file encrypted at rest (`docs/MOBILE.md`, "Encryption at rest").
//!
//! The pools are kept under a random data key, itself stored wrapped by the app's key
//! in a small key file next to them. The pools file is a sequence of blocks:
//!
//! ```text
//! file   = header ‖ block*
//! header = nonce (24) ‖ XChaCha20-Poly1305(header key, u64 BE logical length) (8 + 16)
//! block  = nonce (24) ‖ XChaCha20-Poly1305(block key, 4096 bytes,
//!                                          aad = file id ‖ u64 BE block index) (4096 + 16)
//! ```
//!
//! Every write draws a fresh random nonce, so rewriting a page never reuses a keystream,
//! and every block is authenticated and bound to its place: a changed, moved or zeroed
//! block fails to read. What it does not prevent is putting back an older copy of the
//! same block (a rollback), which only someone writing to the phone's storage can do.
//!
//! [`crate::MeshNodeCore::wipe`] destroys the key file first: what is left of the pools
//! on flash no longer decrypts, even with the app's key.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use parking_lot::RwLock;
use rand::RngCore;
use zeroize::Zeroizing;

/// Logical bytes per block.
pub const BLOCK: usize = 4096;
const NONCE: usize = 24;
const TAG: usize = 16;
/// Bytes a block takes in the file.
pub const PHYSICAL_BLOCK: usize = NONCE + BLOCK + TAG;
const HEADER: usize = NONCE + 8 + TAG;

const KEY_FILE_MAGIC: &[u8; 8] = b"GMPKEY02";
const FILE_ID: usize = 16;
const WRAPPED: usize = NONCE + 32 + TAG;
/// Length of the key file.
pub const KEY_FILE_LEN: usize = KEY_FILE_MAGIC.len() + FILE_ID + WRAPPED;

fn subkey(context: &str, key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(blake3::derive_key(context, key))
}

fn aead(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

fn random_nonce() -> [u8; NONCE] {
    let mut n = [0u8; NONCE];
    rand::thread_rng().fill_bytes(&mut n);
    n
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

/// What the key file holds: the file id and the data key, unwrapped.
struct DataKey {
    file_id: [u8; FILE_ID],
    key: Zeroizing<[u8; 32]>,
}

impl DataKey {
    /// Reads the key file at `path` with the app's key, or creates it (with a fresh data
    /// key) when it does not exist. Also says whether it was created.
    fn load_or_create(path: &Path, app_key: &[u8; 32]) -> io::Result<(Self, bool)> {
        let wrap = aead(&subkey("gossip-mobile/pools/wrap/v2", app_key));
        match std::fs::read(path) {
            Ok(data) => {
                if data.len() != KEY_FILE_LEN || &data[..8] != KEY_FILE_MAGIC {
                    return Err(invalid("not a pools key file"));
                }
                let file_id: [u8; FILE_ID] = data[8..8 + FILE_ID].try_into().expect("16 bytes");
                let wrapped = &data[8 + FILE_ID..];
                let plain = Zeroizing::new(
                    wrap.decrypt(
                        XNonce::from_slice(&wrapped[..NONCE]),
                        Payload {
                            msg: &wrapped[NONCE..],
                            aad: &file_id,
                        },
                    )
                    .map_err(|_| invalid("the pools key file does not open with this key"))?,
                );
                let key: [u8; 32] = plain.as_slice().try_into().map_err(|_| invalid("key"))?;
                Ok((
                    Self {
                        file_id,
                        key: Zeroizing::new(key),
                    },
                    false,
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let mut key = Zeroizing::new([0u8; 32]);
                rand::thread_rng().fill_bytes(key.as_mut());
                let mut file_id = [0u8; FILE_ID];
                rand::thread_rng().fill_bytes(&mut file_id);
                let nonce = random_nonce();
                let ct = wrap
                    .encrypt(
                        XNonce::from_slice(&nonce),
                        Payload {
                            msg: key.as_slice(),
                            aad: &file_id,
                        },
                    )
                    .expect("small message");
                let mut data = Vec::with_capacity(KEY_FILE_LEN);
                data.extend_from_slice(KEY_FILE_MAGIC);
                data.extend_from_slice(&file_id);
                data.extend_from_slice(&nonce);
                data.extend_from_slice(&ct);
                let tmp = path.with_extension("tmp");
                std::fs::write(&tmp, &data)?;
                File::open(&tmp)?.sync_all()?;
                std::fs::rename(&tmp, path)?;
                Ok((Self { file_id, key }, true))
            }
            Err(e) => Err(e),
        }
    }
}

/// Overwrites then deletes a key file, so that the data it wrapped no longer opens.
pub fn destroy_key_file(path: &Path) -> io::Result<()> {
    if let Ok(f) = OpenOptions::new().write(true).open(path) {
        let _ = f.write_all_at(&[0u8; KEY_FILE_LEN], 0);
        let _ = f.sync_all();
    }
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The pools file, encrypted and authenticated block by block.
pub struct EncryptedFile {
    file: File,
    blocks: XChaCha20Poly1305,
    header: XChaCha20Poly1305,
    file_id: [u8; FILE_ID],
    /// Logical length; writers hold it exclusively (read-modify-write of blocks).
    len: RwLock<u64>,
}

impl std::fmt::Debug for EncryptedFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedFile")
            .field("len", &*self.len.read())
            .finish_non_exhaustive()
    }
}

impl EncryptedFile {
    /// Opens or creates the pools file at `path`, with its key file at `key_path`
    /// wrapped by `app_key`. A pools file without a key file (written by an older
    /// version, or left after a wipe) is discarded. The file is locked: a second open
    /// fails while the first is alive.
    pub fn open(path: &Path, key_path: &Path, app_key: &[u8; 32]) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (data_key, created) = DataKey::load_or_create(key_path, app_key)?;
        if created {
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        file.try_lock()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "the pools file is in use"))?;
        let this = Self {
            blocks: aead(&subkey("gossip-mobile/pools/blocks/v2", &data_key.key)),
            header: aead(&subkey("gossip-mobile/pools/header/v2", &data_key.key)),
            file_id: data_key.file_id,
            file,
            len: RwLock::new(0),
        };
        let physical = this.file.metadata()?.len();
        let len = if physical == 0 {
            this.write_header(0)?;
            0
        } else {
            this.read_header()?
        };
        *this.len.write() = len;
        Ok(this)
    }

    fn write_header(&self, len: u64) -> io::Result<()> {
        let nonce = random_nonce();
        let ct = self
            .header
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &len.to_be_bytes(),
                    aad: &self.file_id,
                },
            )
            .expect("small message");
        let mut h = nonce.to_vec();
        h.extend_from_slice(&ct);
        self.file.write_all_at(&h, 0)
    }

    fn read_header(&self) -> io::Result<u64> {
        let mut h = [0u8; HEADER];
        self.file.read_exact_at(&mut h, 0)?;
        let plain = self
            .header
            .decrypt(
                XNonce::from_slice(&h[..NONCE]),
                Payload {
                    msg: &h[NONCE..],
                    aad: &self.file_id,
                },
            )
            .map_err(|_| invalid("pools header does not authenticate"))?;
        Ok(u64::from_be_bytes(
            plain.as_slice().try_into().map_err(|_| invalid("header"))?,
        ))
    }

    fn aad(&self, index: u64) -> [u8; FILE_ID + 8] {
        let mut aad = [0u8; FILE_ID + 8];
        aad[..FILE_ID].copy_from_slice(&self.file_id);
        aad[FILE_ID..].copy_from_slice(&index.to_be_bytes());
        aad
    }

    fn offset_of(index: u64) -> u64 {
        HEADER as u64 + index * PHYSICAL_BLOCK as u64
    }

    fn read_block(&self, index: u64) -> io::Result<Zeroizing<Vec<u8>>> {
        let mut raw = vec![0u8; PHYSICAL_BLOCK];
        self.file.read_exact_at(&mut raw, Self::offset_of(index))?;
        let plain = self
            .blocks
            .decrypt(
                XNonce::from_slice(&raw[..NONCE]),
                Payload {
                    msg: &raw[NONCE..],
                    aad: &self.aad(index),
                },
            )
            .map_err(|_| invalid("pools block does not authenticate"))?;
        Ok(Zeroizing::new(plain))
    }

    fn write_block(&self, index: u64, plain: &[u8]) -> io::Result<()> {
        debug_assert_eq!(plain.len(), BLOCK);
        let nonce = random_nonce();
        let ct = self
            .blocks
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: &self.aad(index),
                },
            )
            .expect("one block");
        let mut raw = nonce.to_vec();
        raw.extend_from_slice(&ct);
        self.file.write_all_at(&raw, Self::offset_of(index))
    }

    fn blocks_for(len: u64) -> u64 {
        len.div_ceil(BLOCK as u64)
    }
}

impl redb::StorageBackend for EncryptedFile {
    fn len(&self) -> Result<u64, io::Error> {
        Ok(*self.len.read())
    }

    fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, io::Error> {
        let logical = self.len.read();
        let end = offset
            .checked_add(len as u64)
            .filter(|e| *e <= *logical)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "read past the end"))?;
        let mut out = Vec::with_capacity(len);
        let mut pos = offset;
        while pos < end {
            let index = pos / BLOCK as u64;
            let within = (pos % BLOCK as u64) as usize;
            let n = (BLOCK - within).min((end - pos) as usize);
            let block = self.read_block(index)?;
            out.extend_from_slice(&block[within..within + n]);
            pos += n as u64;
        }
        Ok(out)
    }

    fn set_len(&self, len: u64) -> Result<(), io::Error> {
        let mut logical = self.len.write();
        self.set_len_locked(&mut logical, len)
    }

    fn sync_data(&self, _eventual: bool) -> Result<(), io::Error> {
        self.file.sync_data()
    }

    fn write(&self, offset: u64, data: &[u8]) -> Result<(), io::Error> {
        let mut logical = self.len.write();
        let end = offset
            .checked_add(data.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "write too far"))?;
        if end > *logical {
            // like a file: a write past the end extends it
            self.set_len_locked(&mut logical, end)?;
        }
        let mut pos = offset;
        let mut rest = data;
        while pos < end {
            let index = pos / BLOCK as u64;
            let within = (pos % BLOCK as u64) as usize;
            let n = (BLOCK - within).min(rest.len());
            let mut block = if n == BLOCK {
                Zeroizing::new(vec![0u8; BLOCK])
            } else {
                self.read_block(index)?
            };
            block[within..within + n].copy_from_slice(&rest[..n]);
            self.write_block(index, &block)?;
            pos += n as u64;
            rest = &rest[n..];
        }
        Ok(())
    }
}

impl EncryptedFile {
    fn set_len_locked(&self, logical: &mut u64, len: u64) -> Result<(), io::Error> {
        let (old_blocks, new_blocks) = (Self::blocks_for(*logical), Self::blocks_for(len));
        if new_blocks > old_blocks {
            // new blocks hold authenticated zeros: a zeroed block never reads as valid
            let zeros = vec![0u8; BLOCK];
            for i in old_blocks..new_blocks {
                self.write_block(i, &zeros)?;
            }
        } else if len < *logical && !len.is_multiple_of(BLOCK as u64) && new_blocks > 0 {
            // zero the cut tail of the last block, as a file would
            let last = new_blocks - 1;
            let mut b = self.read_block(last)?.to_vec();
            b[(len % BLOCK as u64) as usize..].fill(0);
            self.write_block(last, &b)?;
        }
        self.file.set_len(Self::offset_of(new_blocks))?;
        self.write_header(len)?;
        *logical = len;
        Ok(())
    }
}

/// Encrypts a small file's contents with a subkey of `key`:
/// `nonce (24) ‖ XChaCha20-Poly1305(plaintext)`.
pub fn seal(key: &[u8; 32], plain: &[u8]) -> Vec<u8> {
    let nonce = random_nonce();
    let ct = aead(&subkey("gossip-mobile/sealed-file/v2", key))
        .encrypt(XNonce::from_slice(&nonce), plain)
        .expect("small file");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    out
}

/// Decrypts what [`seal`] wrote; `None` when it was not written with this key or was
/// altered.
pub fn open_sealed(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < NONCE + TAG {
        return None;
    }
    aead(&subkey("gossip-mobile/sealed-file/v2", key))
        .decrypt(XNonce::from_slice(&data[..NONCE]), &data[NONCE..])
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use redb::StorageBackend;

    fn open(dir: &Path, key: [u8; 32]) -> io::Result<EncryptedFile> {
        EncryptedFile::open(&dir.join("p.redb"), &dir.join("p.key"), &key)
    }

    #[test]
    fn contents_round_trip_across_blocks_and_are_not_plain_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = b"seeker-".iter().cycle().take(10_000).copied().collect();
        {
            let f = open(dir.path(), [7; 32]).unwrap();
            f.set_len(BLOCK as u64).unwrap();
            // a write past the end extends the file
            f.write(4000, &data).unwrap();
            assert_eq!(f.len().unwrap(), 14_000);
            f.set_len(4 * BLOCK as u64 + 100).unwrap();
            assert_eq!(f.read(4000, data.len()).unwrap(), data);
            assert_eq!(f.read(0, 10).unwrap(), vec![0; 10], "grown with zeros");
            assert!(f.read(4 * BLOCK as u64, 200).is_err(), "past the end");
            // the same page written twice gets a fresh nonce
            let before = std::fs::read(dir.path().join("p.redb")).unwrap();
            f.write(4000, &data).unwrap();
            let after = std::fs::read(dir.path().join("p.redb")).unwrap();
            assert_ne!(before, after);
        }
        let raw = std::fs::read(dir.path().join("p.redb")).unwrap();
        assert!(!raw.windows(6).any(|w| w == b"seeker"));
        // reopened with the key: same contents and length
        let f = open(dir.path(), [7; 32]).unwrap();
        assert_eq!(f.len().unwrap(), 4 * BLOCK as u64 + 100);
        assert_eq!(f.read(4000, data.len()).unwrap(), data);
        drop(f);
        // another key does not open it
        assert!(open(dir.path(), [8; 32]).is_err());
    }

    #[test]
    fn tampered_moved_or_zeroed_blocks_fail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.redb");
        {
            let f = open(dir.path(), [7; 32]).unwrap();
            f.set_len(2 * BLOCK as u64).unwrap();
            f.write(0, &[1; BLOCK]).unwrap();
            f.write(BLOCK as u64, &[2; BLOCK]).unwrap();
        }
        let good = std::fs::read(&path).unwrap();
        let block = |i: usize| HEADER + i * PHYSICAL_BLOCK;
        // a flipped byte
        let mut bad = good.clone();
        bad[block(1) + 100] ^= 1;
        std::fs::write(&path, &bad).unwrap();
        assert!(open(dir.path(), [7; 32])
            .unwrap()
            .read(BLOCK as u64, 10)
            .is_err());
        // two blocks swapped
        let mut swapped = good.clone();
        let (a, b) = (good[block(0)..block(1)].to_vec(), good[block(1)..].to_vec());
        swapped[block(0)..block(1)].copy_from_slice(&b);
        swapped[block(1)..].copy_from_slice(&a);
        std::fs::write(&path, &swapped).unwrap();
        assert!(open(dir.path(), [7; 32]).unwrap().read(0, 10).is_err());
        // a zeroed block
        let mut zeroed = good.clone();
        zeroed[block(0)..block(1)].fill(0);
        std::fs::write(&path, &zeroed).unwrap();
        assert!(open(dir.path(), [7; 32]).unwrap().read(0, 10).is_err());
    }

    #[test]
    fn the_file_is_locked_and_destroying_the_key_erases_it() {
        let dir = tempfile::tempdir().unwrap();
        let f = open(dir.path(), [7; 32]).unwrap();
        f.set_len(BLOCK as u64).unwrap();
        f.write(0, b"secret").unwrap();
        assert!(open(dir.path(), [7; 32]).is_err(), "locked while open");
        drop(f);
        destroy_key_file(&dir.path().join("p.key")).unwrap();
        // the old pools are discarded with a new data key, even with the same app key
        let g = open(dir.path(), [7; 32]).unwrap();
        assert_eq!(g.len().unwrap(), 0);
    }

    #[test]
    fn sealed_files_round_trip_and_detect_changes() {
        let s = seal(&[1; 32], b"wanted");
        assert_eq!(open_sealed(&[1; 32], &s).unwrap(), b"wanted");
        assert!(open_sealed(&[2; 32], &s).is_none());
        let mut t = s.clone();
        t[30] ^= 1;
        assert!(open_sealed(&[1; 32], &t).is_none());
    }
}
