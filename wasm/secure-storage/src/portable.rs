//! Canonical portable backup container codec.
//!
//! This module owns only password-independent framing, completeness, and
//! corruption validation. Backends stage decoded records and install them only
//! after [`PortableArchiveReader::finish`] succeeds.

use std::io::{ErrorKind, Read, Write};

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::constants::{AEAD_TAG_SIZE, BLOCK_SIZE, SESSION_COUNT};
use crate::error::{Result, SecureStorageError};
#[cfg(test)]
use crate::keypair::KeypairFile;
use crate::pq::PqPublicKey;

/// Exact version-1 file prefix.
pub const PORTABLE_MAGIC: [u8; 8] = *b"GOSSIPBK";
/// Initial portable container version.
pub const PORTABLE_VERSION: u64 = 1;
/// Fixed version-1 header width.
pub const PORTABLE_HEADER_SIZE: u64 = 40;
/// SHA-256 suffix width.
pub const PORTABLE_DIGEST_SIZE: u64 = 32;
/// Uniform record-frame width before the value.
pub const PORTABLE_RECORD_HEADER_SIZE: u64 = 26;
/// Maximum complete version-1 artifact size: 64 GiB.
pub const MAX_PORTABLE_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024 * 1024;

const KEYPAIR_KIND: u8 = 0;
const BLOCK_KIND: u8 = 1;
const V1_SLOT_CAPACITY: u8 = 3;
const V1_NAMESPACE_COUNT: u64 = 2;
const V1_BLOCK_SIZE: usize = 65_536;
const V1_LEGACY_KEYPAIR_VERSION: u32 = 0;
const V1_CURRENT_KEYPAIR_VERSION: u32 = 1;
const V1_PUBLIC_KEY_SIZE: usize = 65_536;
const V1_SECRET_KEY_SIZE: usize = 32_768;
const V1_NONCE_SIZE: usize = 16;
const V1_AEAD_TAG_SIZE: usize = 16;
const V1_LEGACY_KEYPAIR_VALUE_SIZE: usize =
    4 + V1_PUBLIC_KEY_SIZE + V1_NONCE_SIZE + V1_SECRET_KEY_SIZE + V1_AEAD_TAG_SIZE;
const V1_CURRENT_KEYPAIR_VALUE_SIZE: usize = V1_LEGACY_KEYPAIR_VALUE_SIZE + 12;
const V1_MAX_KEYPAIR_VALUE_SIZE: u64 = 16 * 1024 * 1024;

// Version 1 freezes these wire values. A dependency/storage change must not
// silently redefine its decoder or exporter.
const _: () = assert!(SESSION_COUNT == V1_SLOT_CAPACITY as usize);
const _: () = assert!(BLOCK_SIZE == V1_BLOCK_SIZE);
const _: () = assert!(PqPublicKey::byte_size() == V1_PUBLIC_KEY_SIZE);
const _: () = assert!(crate::pq::PqSecretKey::byte_size() == V1_SECRET_KEY_SIZE);
const _: () = assert!(crypto_aead::NONCE_SIZE == V1_NONCE_SIZE);
const _: () = assert!(AEAD_TAG_SIZE == V1_AEAD_TAG_SIZE);

/// Logical record kind encoded in a portable archive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PortableRecordKind {
    Keypair,
    Block,
}

impl PortableRecordKind {
    fn encode(self) -> u8 {
        match self {
            Self::Keypair => KEYPAIR_KIND,
            Self::Block => BLOCK_KIND,
        }
    }

    fn decode(value: u8) -> Result<Self> {
        match value {
            KEYPAIR_KIND => Ok(Self::Keypair),
            BLOCK_KIND => Ok(Self::Block),
            _ => Err(SecureStorageError::InvalidPortableArchive),
        }
    }
}

/// One exact logical secure-storage record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortableRecord {
    pub kind: PortableRecordKind,
    pub slot: u8,
    pub namespace: u64,
    pub block_index: u64,
    pub value: Vec<u8>,
}

impl Drop for PortableRecord {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

impl PortableRecord {
    #[must_use]
    pub fn keypair(slot: u8, value: Vec<u8>) -> Self {
        Self {
            kind: PortableRecordKind::Keypair,
            slot,
            namespace: 0,
            block_index: 0,
            value,
        }
    }

    #[must_use]
    pub fn block(slot: u8, namespace: u8, block_index: u64, value: Vec<u8>) -> Self {
        Self {
            kind: PortableRecordKind::Block,
            slot,
            namespace: u64::from(namespace),
            block_index,
            value,
        }
    }

    fn encoded_len(&self) -> Result<u64> {
        PORTABLE_RECORD_HEADER_SIZE
            .checked_add(u64::try_from(self.value.len()).map_err(|_| SecureStorageError::Overflow)?)
            .ok_or(SecureStorageError::Overflow)
    }
}

/// Password-independent fixed header.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PortableHeader {
    pub record_count: u64,
    pub record_section_length: u64,
}

pub(crate) fn validate_portable_keypair_value(value: &[u8]) -> Result<()> {
    if value.len() < 4 {
        return Err(SecureStorageError::InvalidPortableArchive);
    }
    let version = u32::from_be_bytes(
        value[0..4]
            .try_into()
            .map_err(|_| SecureStorageError::InvalidPortableArchive)?,
    );
    let expected_size = match version {
        V1_LEGACY_KEYPAIR_VERSION => V1_LEGACY_KEYPAIR_VALUE_SIZE,
        V1_CURRENT_KEYPAIR_VERSION => V1_CURRENT_KEYPAIR_VALUE_SIZE,
        version => {
            return Err(SecureStorageError::UnsupportedPortableVersion(u64::from(
                version,
            )));
        }
    };
    if value.len() != expected_size {
        return Err(SecureStorageError::InvalidPortableArchive);
    }
    crate::keypair::KeypairFile::deserialize(value)
        .map_err(|_| SecureStorageError::InvalidPortableArchive)?;
    Ok(())
}

pub(crate) fn validate_portable_block_value(value: &[u8]) -> Result<()> {
    if value.len() != V1_BLOCK_SIZE {
        return Err(SecureStorageError::InvalidPortableArchive);
    }
    crate::pq::validate_pq_ciphertext(value).map_err(|_| SecureStorageError::InvalidPortableArchive)
}

#[derive(Default)]
struct LayoutValidator {
    keypairs_seen: u8,
    block_started: bool,
    current_namespace: u64,
    current_block: u64,
    expected_slot: u8,
}

impl LayoutValidator {
    fn observe(&mut self, record: &PortableRecord) -> Result<()> {
        if record.slot >= V1_SLOT_CAPACITY {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        match record.kind {
            PortableRecordKind::Keypair => self.observe_keypair(record),
            PortableRecordKind::Block => self.observe_block(record),
        }
    }

    fn observe_keypair(&mut self, record: &PortableRecord) -> Result<()> {
        if self.block_started
            || self.keypairs_seen >= V1_SLOT_CAPACITY
            || record.slot != self.keypairs_seen
            || record.namespace != 0
            || record.block_index != 0
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        validate_portable_keypair_value(&record.value)?;

        self.keypairs_seen += 1;
        Ok(())
    }

    fn observe_block(&mut self, record: &PortableRecord) -> Result<()> {
        if self.keypairs_seen != V1_SLOT_CAPACITY || record.namespace >= V1_NAMESPACE_COUNT {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        validate_portable_block_value(&record.value)?;

        if !self.block_started {
            if record.namespace != 0 || record.block_index != 0 || record.slot != 0 {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            self.block_started = true;
            self.current_namespace = 0;
            self.current_block = 0;
            self.expected_slot = 0;
        }

        if record.namespace != self.current_namespace
            || record.block_index != self.current_block
            || record.slot != self.expected_slot
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        self.expected_slot += 1;
        if self.expected_slot == V1_SLOT_CAPACITY {
            self.expected_slot = 0;
            self.current_block = self
                .current_block
                .checked_add(1)
                .ok_or(SecureStorageError::Overflow)?;
        }
        Ok(())
    }

    fn finish(&self) -> Result<()> {
        if self.keypairs_seen != V1_SLOT_CAPACITY || !self.block_started || self.expected_slot != 0
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        Ok(())
    }

    fn transition_namespace(&mut self, record: &PortableRecord) -> Result<()> {
        if self.block_started
            && self.expected_slot == 0
            && self.current_namespace == 0
            && record.kind == PortableRecordKind::Block
            && record.namespace == 1
            && record.block_index == 0
            && record.slot == 0
        {
            self.current_namespace = 1;
            self.current_block = 0;
        }
        Ok(())
    }
}

fn checked_total_size(record_section_length: u64) -> Result<u64> {
    let total = PORTABLE_HEADER_SIZE
        .checked_add(record_section_length)
        .and_then(|value| value.checked_add(PORTABLE_DIGEST_SIZE))
        .ok_or(SecureStorageError::Overflow)?;
    if total > MAX_PORTABLE_ARCHIVE_BYTES {
        return Err(SecureStorageError::PortableArchiveTooLarge);
    }
    Ok(total)
}

fn read_exact_archive<R: Read>(input: &mut R, bytes: &mut [u8]) -> Result<()> {
    match input.read_exact(bytes) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
            Err(SecureStorageError::InvalidPortableArchive)
        }
        Err(error) => Err(SecureStorageError::Io(error)),
    }
}

fn header_bytes(header: PortableHeader) -> [u8; PORTABLE_HEADER_SIZE as usize] {
    let mut bytes = [0_u8; PORTABLE_HEADER_SIZE as usize];
    bytes[0..8].copy_from_slice(&PORTABLE_MAGIC);
    bytes[8..16].copy_from_slice(&PORTABLE_VERSION.to_be_bytes());
    bytes[16..24].copy_from_slice(&u64::from(V1_SLOT_CAPACITY).to_be_bytes());
    bytes[24..32].copy_from_slice(&header.record_count.to_be_bytes());
    bytes[32..40].copy_from_slice(&header.record_section_length.to_be_bytes());
    bytes
}

/// Streaming canonical archive writer.
pub struct PortableArchiveWriter<W: Write> {
    output: W,
    hasher: Sha256,
    header: PortableHeader,
    records_written: u64,
    record_bytes_written: u64,
    layout: LayoutValidator,
}

impl<W: Write> PortableArchiveWriter<W> {
    pub fn new(mut output: W, header: PortableHeader) -> Result<Self> {
        checked_total_size(header.record_section_length)?;
        if header.record_count < u64::from(V1_SLOT_CAPACITY)
            || (header.record_count - u64::from(V1_SLOT_CAPACITY)) % u64::from(V1_SLOT_CAPACITY)
                != 0
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let bytes = header_bytes(header);
        output.write_all(&bytes)?;
        let mut hasher = Sha256::new();
        hasher.update(bytes);

        Ok(Self {
            output,
            hasher,
            header,
            records_written: 0,
            record_bytes_written: 0,
            layout: LayoutValidator::default(),
        })
    }

    pub fn write_record(&mut self, record: &PortableRecord) -> Result<()> {
        if self.records_written >= self.header.record_count {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        self.layout.transition_namespace(record)?;
        self.layout.observe(record)?;

        let encoded_len = record.encoded_len()?;
        let next_len = self
            .record_bytes_written
            .checked_add(encoded_len)
            .ok_or(SecureStorageError::Overflow)?;
        if next_len > self.header.record_section_length {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let value_len =
            u64::try_from(record.value.len()).map_err(|_| SecureStorageError::Overflow)?;
        let mut frame = [0_u8; PORTABLE_RECORD_HEADER_SIZE as usize];
        frame[0] = record.kind.encode();
        frame[1] = record.slot;
        frame[2..10].copy_from_slice(&record.namespace.to_be_bytes());
        frame[10..18].copy_from_slice(&record.block_index.to_be_bytes());
        frame[18..26].copy_from_slice(&value_len.to_be_bytes());

        self.output.write_all(&frame)?;
        self.output.write_all(&record.value)?;
        self.hasher.update(frame);
        self.hasher.update(&record.value);
        self.records_written += 1;
        self.record_bytes_written = next_len;
        Ok(())
    }

    pub fn finish(mut self) -> Result<W> {
        self.layout.finish()?;
        if self.records_written != self.header.record_count
            || self.record_bytes_written != self.header.record_section_length
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let digest = self.hasher.finalize();
        self.output.write_all(&digest)?;
        self.output.flush()?;
        Ok(self.output)
    }
}

/// Streaming canonical archive reader.
pub struct PortableArchiveReader<R: Read> {
    input: R,
    hasher: Sha256,
    header: PortableHeader,
    records_read: u64,
    record_bytes_read: u64,
    layout: LayoutValidator,
}

impl<R: Read> PortableArchiveReader<R> {
    pub fn new(mut input: R) -> Result<Self> {
        let mut prefix = [0_u8; 16];
        read_exact_archive(&mut input, &mut prefix)?;
        if prefix[0..8] != PORTABLE_MAGIC {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        let version = u64::from_be_bytes(prefix[8..16].try_into().expect("fixed slice"));
        if version != PORTABLE_VERSION {
            return Err(SecureStorageError::UnsupportedPortableVersion(version));
        }

        let mut remainder = [0_u8; PORTABLE_HEADER_SIZE as usize - 16];
        read_exact_archive(&mut input, &mut remainder)?;
        let capacity = u64::from_be_bytes(remainder[0..8].try_into().expect("fixed slice"));
        if capacity != u64::from(V1_SLOT_CAPACITY) {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let header = PortableHeader {
            record_count: u64::from_be_bytes(remainder[8..16].try_into().expect("fixed slice")),
            record_section_length: u64::from_be_bytes(
                remainder[16..24].try_into().expect("fixed slice"),
            ),
        };
        checked_total_size(header.record_section_length)?;
        if header.record_count < u64::from(V1_SLOT_CAPACITY)
            || (header.record_count - u64::from(V1_SLOT_CAPACITY)) % u64::from(V1_SLOT_CAPACITY)
                != 0
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let mut hasher = Sha256::new();
        hasher.update(prefix);
        hasher.update(remainder);
        Ok(Self {
            input,
            hasher,
            header,
            records_read: 0,
            record_bytes_read: 0,
            layout: LayoutValidator::default(),
        })
    }

    #[must_use]
    pub fn header(&self) -> PortableHeader {
        self.header
    }

    pub fn read_record(&mut self) -> Result<Option<PortableRecord>> {
        if self.records_read == self.header.record_count {
            return Ok(None);
        }

        let mut frame = [0_u8; PORTABLE_RECORD_HEADER_SIZE as usize];
        read_exact_archive(&mut self.input, &mut frame)?;
        let kind = PortableRecordKind::decode(frame[0])?;
        let value_len = u64::from_be_bytes(frame[18..26].try_into().expect("fixed slice"));
        match kind {
            PortableRecordKind::Keypair
                if !(4..=V1_MAX_KEYPAIR_VALUE_SIZE).contains(&value_len) =>
            {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            PortableRecordKind::Block if value_len != V1_BLOCK_SIZE as u64 => {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            _ => {}
        }

        let encoded_len = PORTABLE_RECORD_HEADER_SIZE
            .checked_add(value_len)
            .ok_or(SecureStorageError::Overflow)?;
        let next_len = self
            .record_bytes_read
            .checked_add(encoded_len)
            .ok_or(SecureStorageError::Overflow)?;
        if next_len > self.header.record_section_length {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let value_size = usize::try_from(value_len).map_err(|_| SecureStorageError::Overflow)?;
        let value = if kind == PortableRecordKind::Keypair {
            let mut version_bytes = [0_u8; 4];
            read_exact_archive(&mut self.input, &mut version_bytes)?;
            let version = u32::from_be_bytes(version_bytes);
            let expected_size = match version {
                V1_LEGACY_KEYPAIR_VERSION => V1_LEGACY_KEYPAIR_VALUE_SIZE,
                V1_CURRENT_KEYPAIR_VERSION => V1_CURRENT_KEYPAIR_VALUE_SIZE,
                version => {
                    return Err(SecureStorageError::UnsupportedPortableVersion(u64::from(
                        version,
                    )));
                }
            };
            if value_len != expected_size as u64 {
                return Err(SecureStorageError::InvalidPortableArchive);
            }
            let mut value = Zeroizing::new(vec![0_u8; value_size]);
            value[0..4].copy_from_slice(&version_bytes);
            read_exact_archive(&mut self.input, &mut value[4..])?;
            std::mem::take(&mut *value)
        } else {
            let mut value = Zeroizing::new(vec![0_u8; value_size]);
            read_exact_archive(&mut self.input, &mut value)?;
            std::mem::take(&mut *value)
        };
        let record = PortableRecord {
            kind,
            slot: frame[1],
            namespace: u64::from_be_bytes(frame[2..10].try_into().expect("fixed slice")),
            block_index: u64::from_be_bytes(frame[10..18].try_into().expect("fixed slice")),
            value,
        };

        self.layout.transition_namespace(&record)?;
        self.layout.observe(&record)?;
        self.hasher.update(frame);
        self.hasher.update(&record.value);
        self.records_read += 1;
        self.record_bytes_read = next_len;
        Ok(Some(record))
    }

    pub fn finish(mut self) -> Result<R> {
        self.layout.finish()?;
        if self.records_read != self.header.record_count
            || self.record_bytes_read != self.header.record_section_length
        {
            return Err(SecureStorageError::InvalidPortableArchive);
        }

        let mut expected_digest = [0_u8; PORTABLE_DIGEST_SIZE as usize];
        read_exact_archive(&mut self.input, &mut expected_digest)?;
        let actual_digest = self.hasher.finalize();
        if actual_digest.as_slice() != expected_digest {
            return Err(SecureStorageError::PortableChecksumMismatch);
        }

        let mut trailing = [0_u8; 1];
        if self.input.read(&mut trailing)? != 0 {
            return Err(SecureStorageError::InvalidPortableArchive);
        }
        Ok(self.input)
    }
}

#[cfg(test)]
mod tests {
    const V1_KEYPAIR_VERSION: u32 = V1_LEGACY_KEYPAIR_VERSION;
    const V1_KEYPAIR_VALUE_SIZE: usize = V1_LEGACY_KEYPAIR_VALUE_SIZE;
    use std::io::Cursor;

    use super::*;

    fn keypair(slot: u8) -> PortableRecord {
        let file = KeypairFile {
            version: V1_KEYPAIR_VERSION,
            pq_pk: vec![slot; V1_PUBLIC_KEY_SIZE],
            sk_nonce: [slot; V1_NONCE_SIZE],
            sk_ct: vec![slot; V1_SECRET_KEY_SIZE + V1_AEAD_TAG_SIZE],
        };
        PortableRecord::keypair(slot, file.serialize())
    }

    fn block(slot: u8, namespace: u8, block_index: u64) -> PortableRecord {
        PortableRecord::block(
            slot,
            namespace,
            block_index,
            vec![slot.wrapping_add(namespace); V1_BLOCK_SIZE],
        )
    }

    fn minimal_records() -> Vec<PortableRecord> {
        let mut records = (0..V1_SLOT_CAPACITY).map(keypair).collect::<Vec<_>>();
        for slot in 0..V1_SLOT_CAPACITY {
            records.push(block(slot, 0, 0));
        }
        records
    }

    fn records() -> Vec<PortableRecord> {
        let mut records = (0..V1_SLOT_CAPACITY).map(keypair).collect::<Vec<_>>();
        for namespace in 0..=1 {
            for block_index in 0..=1 {
                for slot in 0..V1_SLOT_CAPACITY {
                    records.push(block(slot, namespace, block_index));
                }
            }
        }
        records
    }

    fn replace_digest(bytes: &mut [u8]) {
        let digest_offset = bytes.len() - PORTABLE_DIGEST_SIZE as usize;
        let digest = Sha256::digest(&bytes[..digest_offset]);
        bytes[digest_offset..].copy_from_slice(&digest);
    }

    fn encode(records: &[PortableRecord]) -> Result<Vec<u8>> {
        let record_section_length = records.iter().try_fold(0_u64, |total, record| {
            total
                .checked_add(record.encoded_len()?)
                .ok_or(SecureStorageError::Overflow)
        })?;
        let header = PortableHeader {
            record_count: records.len() as u64,
            record_section_length,
        };
        let mut writer = PortableArchiveWriter::new(Vec::new(), header)?;
        for record in records {
            writer.write_record(record)?;
        }
        writer.finish()
    }

    #[test]
    fn committed_fixture_decodes_and_matches_the_writer() {
        let fixture = include_bytes!("../tests/fixtures/portable-v1-minimal.gossipbackup");
        let expected = minimal_records();
        let mut reader = PortableArchiveReader::new(Cursor::new(fixture.as_slice())).unwrap();
        let mut actual = Vec::new();
        while let Some(record) = reader.read_record().unwrap() {
            actual.push(record);
        }
        reader.finish().unwrap();

        assert_eq!(actual, expected);
        assert_eq!(encode(&expected).unwrap(), fixture);
    }

    #[test]
    fn canonical_roundtrip() {
        let expected = records();
        let bytes = encode(&expected).unwrap();
        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        let mut actual = Vec::new();
        while let Some(record) = reader.read_record().unwrap() {
            actual.push(record);
        }
        reader.finish().unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn header_uses_confirmed_widths_and_values() {
        let bytes = encode(&records()).unwrap();
        assert_eq!(&bytes[0..8], b"GOSSIPBK");
        assert_eq!(&bytes[8..16], &1_u64.to_be_bytes());
        assert_eq!(&bytes[16..24], &3_u64.to_be_bytes());
        assert_eq!(
            &bytes[bytes.len() - PORTABLE_DIGEST_SIZE as usize..],
            &[
                0xb1, 0x46, 0xf7, 0xd2, 0xbb, 0x13, 0x58, 0xd0, 0x3a, 0xd7, 0xe3, 0xfe, 0x91, 0x84,
                0x8c, 0x86, 0x7a, 0x34, 0x47, 0xd2, 0x2a, 0xb2, 0x9e, 0x97, 0x51, 0x8d, 0x6a, 0xbe,
                0x47, 0x6a, 0xc7, 0xe3,
            ]
        );
    }

    #[test]
    fn checksum_detects_record_corruption() {
        let mut bytes = encode(&records()).unwrap();
        let first_block_value = PORTABLE_HEADER_SIZE as usize
            + V1_SLOT_CAPACITY as usize
                * (PORTABLE_RECORD_HEADER_SIZE as usize + V1_KEYPAIR_VALUE_SIZE)
            + PORTABLE_RECORD_HEADER_SIZE as usize;
        bytes[first_block_value] ^= 1;
        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        while reader.read_record().unwrap().is_some() {}
        assert!(matches!(
            reader.finish(),
            Err(SecureStorageError::PortableChecksumMismatch)
        ));
    }

    #[test]
    fn reader_rejects_noncanonical_ciphertext() {
        let mut bytes = encode(&records()).unwrap();
        let first_block_value = PORTABLE_HEADER_SIZE as usize
            + V1_SLOT_CAPACITY as usize
                * (PORTABLE_RECORD_HEADER_SIZE as usize + V1_KEYPAIR_VALUE_SIZE)
            + PORTABLE_RECORD_HEADER_SIZE as usize;
        bytes[first_block_value..first_block_value + V1_BLOCK_SIZE].fill(0xff);
        replace_digest(&mut bytes);

        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        for _ in 0..V1_SLOT_CAPACITY {
            reader.read_record().unwrap();
        }
        assert!(matches!(
            reader.read_record(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn reader_rejects_noncanonical_record_order_with_valid_digest() {
        let mut bytes =
            include_bytes!("../tests/fixtures/portable-v1-minimal.gossipbackup").to_vec();
        let block_frame_size = PORTABLE_RECORD_HEADER_SIZE as usize + V1_BLOCK_SIZE;
        let first_block_frame = PORTABLE_HEADER_SIZE as usize
            + V1_SLOT_CAPACITY as usize
                * (PORTABLE_RECORD_HEADER_SIZE as usize + V1_KEYPAIR_VALUE_SIZE);
        let first = bytes[first_block_frame..first_block_frame + block_frame_size].to_vec();
        let second = bytes
            [first_block_frame + block_frame_size..first_block_frame + 2 * block_frame_size]
            .to_vec();
        bytes[first_block_frame..first_block_frame + block_frame_size].copy_from_slice(&second);
        bytes[first_block_frame + block_frame_size..first_block_frame + 2 * block_frame_size]
            .copy_from_slice(&first);
        replace_digest(&mut bytes);

        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        for _ in 0..V1_SLOT_CAPACITY {
            reader.read_record().unwrap();
        }
        assert!(matches!(
            reader.read_record(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn reader_rejects_header_count_and_length_mismatches() {
        let fixture = include_bytes!("../tests/fixtures/portable-v1-minimal.gossipbackup");

        let mut bad_count = fixture.to_vec();
        bad_count[24..32].copy_from_slice(&9_u64.to_be_bytes());
        replace_digest(&mut bad_count);
        let mut reader = PortableArchiveReader::new(Cursor::new(bad_count)).unwrap();
        assert!(matches!(
            (0..7).try_for_each(|_| reader.read_record().map(|_| ())),
            Err(SecureStorageError::InvalidPortableArchive)
        ));

        let mut bad_length = fixture.to_vec();
        let length = u64::from_be_bytes(bad_length[32..40].try_into().unwrap());
        bad_length[32..40].copy_from_slice(&(length + 1).to_be_bytes());
        replace_digest(&mut bad_length);
        let mut reader = PortableArchiveReader::new(Cursor::new(bad_length)).unwrap();
        while reader.read_record().unwrap().is_some() {}
        assert!(matches!(
            reader.finish(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn reader_rejects_noncanonical_slot_with_valid_digest() {
        let mut bytes = encode(&records()).unwrap();
        let first_block_frame = PORTABLE_HEADER_SIZE as usize
            + V1_SLOT_CAPACITY as usize
                * (PORTABLE_RECORD_HEADER_SIZE as usize + V1_KEYPAIR_VALUE_SIZE);
        bytes[first_block_frame + 1] = 2;
        replace_digest(&mut bytes);

        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        for _ in 0..V1_SLOT_CAPACITY {
            reader.read_record().unwrap();
        }
        assert!(matches!(
            reader.read_record(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn reader_dispatches_top_level_version_from_common_prefix() {
        let mut prefix = Vec::from(PORTABLE_MAGIC);
        prefix.extend_from_slice(&2_u64.to_be_bytes());
        assert!(matches!(
            PortableArchiveReader::new(Cursor::new(prefix)),
            Err(SecureStorageError::UnsupportedPortableVersion(2))
        ));
    }

    #[test]
    fn reader_dispatches_unknown_keypair_version_before_value_size() {
        let mut bytes = encode(&records()).unwrap();
        let first_keypair_value =
            PORTABLE_HEADER_SIZE as usize + PORTABLE_RECORD_HEADER_SIZE as usize;
        bytes[first_keypair_value..first_keypair_value + 4].copy_from_slice(&2_u32.to_be_bytes());
        replace_digest(&mut bytes);

        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        assert!(matches!(
            reader.read_record(),
            Err(SecureStorageError::UnsupportedPortableVersion(2))
        ));
    }

    #[test]
    fn reader_rejects_noncanonical_public_key() {
        let mut bytes = encode(&records()).unwrap();
        let public_key = PORTABLE_HEADER_SIZE as usize + PORTABLE_RECORD_HEADER_SIZE as usize + 4;
        bytes[public_key..public_key + V1_PUBLIC_KEY_SIZE].fill(0xff);
        replace_digest(&mut bytes);

        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        assert!(matches!(
            reader.read_record(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn truncated_header_and_digest_are_invalid_archives() {
        assert!(matches!(
            PortableArchiveReader::new(Cursor::new(Vec::from(&PORTABLE_MAGIC[..]))),
            Err(SecureStorageError::InvalidPortableArchive)
        ));

        let mut bytes = encode(&records()).unwrap();
        bytes.pop();
        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        while reader.read_record().unwrap().is_some() {}
        assert!(matches!(
            reader.finish(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn reader_rejects_oversized_header_without_payload() {
        let oversized_record_section = MAX_PORTABLE_ARCHIVE_BYTES
            .checked_sub(PORTABLE_HEADER_SIZE + PORTABLE_DIGEST_SIZE)
            .unwrap()
            + 1;
        let bytes = header_bytes(PortableHeader {
            record_count: 3,
            record_section_length: oversized_record_section,
        });
        assert!(matches!(
            PortableArchiveReader::new(Cursor::new(bytes)),
            Err(SecureStorageError::PortableArchiveTooLarge)
        ));
    }

    #[test]
    fn rejects_missing_slot_record() {
        let mut invalid = records();
        invalid.remove(4);
        assert!(matches!(
            encode(&invalid),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn rejects_noncanonical_namespace_transition() {
        let mut invalid = records();
        let first_namespace_one = 3 + 2 * V1_SLOT_CAPACITY as usize;
        invalid[first_namespace_one].block_index = 1;
        assert!(matches!(
            encode(&invalid),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bytes = encode(&records()).unwrap();
        bytes.push(0);
        let mut reader = PortableArchiveReader::new(Cursor::new(bytes)).unwrap();
        while reader.read_record().unwrap().is_some() {}
        assert!(matches!(
            reader.finish(),
            Err(SecureStorageError::InvalidPortableArchive)
        ));
    }

    #[test]
    fn rejects_archive_above_limit_without_allocating_it() {
        let oversized_record_section = MAX_PORTABLE_ARCHIVE_BYTES
            .checked_sub(PORTABLE_HEADER_SIZE + PORTABLE_DIGEST_SIZE)
            .unwrap()
            + 1;
        assert!(matches!(
            PortableArchiveWriter::new(
                Vec::new(),
                PortableHeader {
                    record_count: 3,
                    record_section_length: oversized_record_section,
                },
            ),
            Err(SecureStorageError::PortableArchiveTooLarge)
        ));
    }
}
