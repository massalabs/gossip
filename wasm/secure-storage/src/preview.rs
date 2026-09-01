//! Read-only profile validation for an authenticated portable candidate.

#[cfg(feature = "native")]
use std::ffi::CStr;

#[cfg(feature = "native")]
use rusqlite::Connection;
use serde::Deserialize;
#[cfg(feature = "native")]
use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Result, SecureStorageError};

const MAX_SECURITY_JSON_CHARS: usize = 128 * 1024;
#[cfg(feature = "native")]
const MAX_AVATAR_CHARS: usize = 1024 * 1024;

#[cfg(feature = "native")]
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAccountPreview {
    pub user_id: String,
    pub username: String,
    pub avatar: Option<String>,
    pub created_at_ms: i64,
}

fn invalid_profile() -> SecureStorageError {
    SecureStorageError::Storage("imported account profile is invalid".into())
}

#[derive(Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
struct PreviewSecurity {
    format_version: u64,
    password_kdf_version: u64,
    mnemonic_encryption_version: u64,
    identity_derivation_version: u64,
    auth_method: String,
    enc_key_salt: Vec<u8>,
    mnemonic_backup: PreviewMnemonicBackup,
}

#[derive(Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
struct PreviewMnemonicBackup {
    encrypted_mnemonic: Vec<u8>,
    created_at: String,
    #[serde(rename = "backedUp")]
    _backed_up: bool,
}

fn valid_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return false;
    }
    let number = |start: usize, end: usize| -> Option<u32> {
        std::str::from_utf8(&bytes[start..end]).ok()?.parse().ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(millis)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
        number(20, 23),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day >= 1 && day <= max_day && hour <= 23 && minute <= 59 && second <= 59 && millis <= 999
}

pub(crate) fn validate_security(value: &str) -> Result<()> {
    if value.len() > MAX_SECURITY_JSON_CHARS {
        return Err(invalid_profile());
    }
    let security = Zeroizing::new(
        serde_json::from_str::<PreviewSecurity>(value).map_err(|_| invalid_profile())?,
    );
    if security.format_version != 1
        || security.password_kdf_version != 1
        || security.mnemonic_encryption_version != 1
        || security.identity_derivation_version != 1
        || security.auth_method != "password"
        || security.enc_key_salt.len() != 16
        || !(17..=64 * 1024).contains(&security.mnemonic_backup.encrypted_mnemonic.len())
        || !valid_iso_timestamp(&security.mnemonic_backup.created_at)
    {
        return Err(SecureStorageError::UnsupportedVersion(1));
    }
    Ok(())
}

pub(crate) fn valid_user_id(value: &str) -> bool {
    const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    if value.len() != 65 || !value.starts_with("gossip1") {
        return false;
    }
    let mut values = [0_u8; 58];
    for (target, byte) in values.iter_mut().zip(value.bytes().skip(7)) {
        let Some(index) = CHARSET.iter().position(|candidate| *candidate == byte) else {
            return false;
        };
        *target = index as u8;
    }

    let mut polymod = 1_u32;
    let generators = [
        0x3b6a_57b2_u32,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    for part in b"gossip"
        .iter()
        .map(|byte| byte >> 5)
        .chain(std::iter::once(0))
        .chain(b"gossip".iter().map(|byte| byte & 31))
        .chain(values)
    {
        let top = polymod >> 25;
        polymod = ((polymod & 0x01ff_ffff) << 5) ^ u32::from(part);
        for (index, generator) in generators.iter().enumerate() {
            if (top >> index) & 1 != 0 {
                polymod ^= generator;
            }
        }
    }
    if polymod != 1 {
        return false;
    }

    // The first 52 words encode exactly 32 bytes plus four zero padding bits.
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut decoded_bytes = 0_usize;
    for word in values.into_iter().take(52) {
        accumulator = ((accumulator & 0x07ff_ffff) << 5) | u32::from(word);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            decoded_bytes += 1;
        }
    }
    decoded_bytes == 32 && bits < 5 && (accumulator & ((1_u32 << bits) - 1)) == 0
}

#[cfg(feature = "native")]
pub fn query_imported_account_preview(
    mut database: Zeroizing<Vec<u8>>,
) -> Result<ImportedAccountPreview> {
    if database.is_empty()
        || database.len() > i64::MAX as usize
        || database.len() as u64 > crate::read::MAX_PREVIEW_DATABASE_BYTES
    {
        return Err(invalid_profile());
    }
    let connection = Connection::open_in_memory()
        .map_err(|error| SecureStorageError::Storage(format!("preview sqlite open: {error}")))?;
    connection
        .set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|error| {
            SecureStorageError::Storage(format!("preview sqlite defensive mode: {error}"))
        })?;
    let len = database.len();
    let schema: &CStr = c"main";
    // SAFETY: database remains alive and uniquely owned until after the
    // connection closes. READONLY omits FREEONCLOSE, so SQLite never frees or
    // resizes this Rust-owned buffer; Zeroizing wipes it after close.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_deserialize(
            connection.handle(),
            schema.as_ptr(),
            database.as_mut_ptr(),
            len as i64,
            len as i64,
            rusqlite::ffi::SQLITE_DESERIALIZE_READONLY,
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(SecureStorageError::Storage(format!(
            "preview sqlite image error code: {rc}"
        )));
    }

    let result = (|| {
        connection
            .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
            .map_err(|error| {
                SecureStorageError::Storage(format!("preview sqlite pragma: {error}"))
            })?;
        let mut integrity = connection.prepare("PRAGMA quick_check").map_err(|error| {
            SecureStorageError::Storage(format!("preview sqlite integrity prepare: {error}"))
        })?;
        let mut integrity_rows = integrity.query([]).map_err(|error| {
            SecureStorageError::Storage(format!("preview sqlite integrity rows: {error}"))
        })?;
        let first = integrity_rows
            .next()
            .map_err(|error| {
                SecureStorageError::Storage(format!("preview sqlite integrity row: {error}"))
            })?
            .ok_or_else(invalid_profile)?;
        if first.get::<_, String>(0).map_err(|_| invalid_profile())? != "ok"
            || integrity_rows
                .next()
                .map_err(|error| {
                    SecureStorageError::Storage(format!("preview sqlite integrity row: {error}"))
                })?
                .is_some()
        {
            return Err(invalid_profile());
        }
        drop(integrity_rows);
        drop(integrity);

        let mut statement = connection
            .prepare(
                "SELECT userId, username, avatar, createdAt, security \
                 FROM userProfile LIMIT 2",
            )
            .map_err(|error| {
                SecureStorageError::Storage(format!("preview profile query: {error}"))
            })?;
        let mut rows = statement.query([]).map_err(|error| {
            SecureStorageError::Storage(format!("preview profile rows: {error}"))
        })?;
        let row = rows
            .next()
            .map_err(|error| SecureStorageError::Storage(format!("preview profile row: {error}")))?
            .ok_or_else(invalid_profile)?;
        let user_id: String = row.get(0).map_err(|_| invalid_profile())?;
        let username: String = row.get(1).map_err(|_| invalid_profile())?;
        let avatar: Option<String> = row.get(2).map_err(|_| invalid_profile())?;
        let created_at_ms: i64 = row.get(3).map_err(|_| invalid_profile())?;
        let security = Zeroizing::new(row.get::<_, String>(4).map_err(|_| invalid_profile())?);
        if rows
            .next()
            .map_err(|error| SecureStorageError::Storage(format!("preview profile row: {error}")))?
            .is_some()
            || !valid_user_id(&user_id)
            || username.is_empty()
            || username.len() > 128
            || avatar
                .as_ref()
                .is_some_and(|value| value.len() > MAX_AVATAR_CHARS)
            || !(0..=9_007_199_254_740_991).contains(&created_at_ms)
        {
            return Err(invalid_profile());
        }
        validate_security(&security)?;
        Ok(ImportedAccountPreview {
            user_id,
            username,
            avatar,
            created_at_ms,
        })
    })();
    drop(connection);
    result
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;

    const USER_ID: &str = "gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s";
    const SECURITY: &str = r#"{
        "formatVersion":1,
        "passwordKdfVersion":1,
        "mnemonicEncryptionVersion":1,
        "identityDerivationVersion":1,
        "authMethod":"password",
        "encKeySalt":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
        "mnemonicBackup":{
            "encryptedMnemonic":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
            "createdAt":"2026-01-01T00:00:00.000Z",
            "backedUp":false
        }
    }"#;

    fn image(rows: &[(&str, &str)]) -> Zeroizing<Vec<u8>> {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE userProfile (
                    userId TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    avatar TEXT,
                    createdAt INTEGER NOT NULL,
                    security TEXT NOT NULL
                );",
            )
            .unwrap();
        for (username, security) in rows {
            connection
                .execute(
                    "INSERT INTO userProfile VALUES (?1, ?2, NULL, 1234, ?3)",
                    (USER_ID, username, security),
                )
                .unwrap();
        }
        let serialized = connection.serialize(rusqlite::DatabaseName::Main).unwrap();
        Zeroizing::new(serialized.to_vec())
    }

    #[test]
    fn projects_only_bounded_public_profile_fields() {
        let preview = query_imported_account_preview(image(&[("Alice", SECURITY)])).unwrap();
        assert_eq!(preview.user_id, USER_ID);
        assert_eq!(preview.username, "Alice");
        assert_eq!(preview.avatar, None);
        assert_eq!(preview.created_at_ms, 1234);
    }

    #[test]
    fn rejects_unsupported_security_before_returning_preview() {
        let unsupported = SECURITY.replace("\"formatVersion\":1", "\"formatVersion\":2");
        assert!(query_imported_account_preview(image(&[("Alice", &unsupported)])).is_err());
    }

    #[test]
    fn rejects_noncanonical_security_timestamp() {
        let invalid = SECURITY.replace("2026-01-01T00:00:00.000Z", "not-a-timestamp");
        assert!(query_imported_account_preview(image(&[("Alice", &invalid)])).is_err());
    }

    #[test]
    fn rejects_user_id_with_invalid_bech32_checksum() {
        let mut invalid = USER_ID.to_string();
        invalid.replace_range(64..65, if invalid.ends_with('q') { "p" } else { "q" });
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE userProfile (
                    userId TEXT, username TEXT, avatar TEXT,
                    createdAt INTEGER, security TEXT
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO userProfile VALUES (?1, 'Alice', NULL, 1234, ?2)",
                (&invalid, SECURITY),
            )
            .unwrap();
        let serialized = connection.serialize(rusqlite::DatabaseName::Main).unwrap();
        assert!(query_imported_account_preview(Zeroizing::new(serialized.to_vec())).is_err());
    }

    #[test]
    fn rejects_structural_corruption_outside_the_profile_query() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA page_size = 4096;
                 CREATE TABLE userProfile (
                    userId TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    avatar TEXT,
                    createdAt INTEGER NOT NULL,
                    security TEXT NOT NULL
                 );
                 CREATE TABLE unrelated(payload BLOB NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO userProfile VALUES (?1, 'Alice', NULL, 1234, ?2)",
                (USER_ID, SECURITY),
            )
            .unwrap();
        connection
            .execute("INSERT INTO unrelated VALUES (zeroblob(8192))", [])
            .unwrap();
        let root_page: usize = connection
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name = 'unrelated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let serialized = connection.serialize(rusqlite::DatabaseName::Main).unwrap();
        let mut corrupted = serialized.to_vec();
        corrupted[(root_page - 1) * 4096] = 0xff;

        assert!(query_imported_account_preview(Zeroizing::new(corrupted)).is_err());
    }

    #[test]
    fn rejects_empty_profile_database() {
        assert!(query_imported_account_preview(image(&[])).is_err());
    }
}
