//! Integration tests simulating real chat app scenarios
//!
//! These tests verify the storage layer works correctly for typical
//! chat application workflows.
//!
//! ## Running tests
//!
//! **Fast development tests (recommended):**
//! ```bash
//! cargo test --features test-constants --test chat_app_scenarios -- --test-threads=1
//! ```
//!
//! **Why `--test-threads=1`?**
//! Each session create/unlock calls Argon2id (password KDF) which uses 32 MiB memory
//! and takes 1-3 seconds per call. Running tests in parallel causes CPU contention
//! (500%+ CPU usage) and slower overall execution. Single-threaded is actually faster.
//!
//! **Why `--features test-constants`?**
//! Without this feature, tests use PROD padding values (5-600 MB per block).
//! With this feature, tests use small values (1-10 KB) for fast execution.
//!
//! ## PROD tests (real phone scenario):
//! ```bash
//! cargo test prod_real --release -- --ignored --nocapture --test-threads=1
//! ```

use gossip_storage::{
    SessionManager, SessionState, InMemoryFs, FileSystem,
    FILE_DATA, FILE_ADDRESSING, write_random_padding,
};

/// Simulates SQLite page writes (4KB pages)
const SQLITE_PAGE_SIZE: usize = 4096;

/// Helper to create test messages of varying sizes
fn make_message(id: u32, content: &str) -> Vec<u8> {
    // Simulate a message structure: id (4 bytes) + timestamp (8 bytes) + content
    let mut msg = Vec::new();
    msg.extend_from_slice(&id.to_le_bytes());
    msg.extend_from_slice(&(1704067200u64 + id as u64).to_le_bytes()); // timestamp
    msg.extend_from_slice(content.as_bytes());
    msg
}

/// Helper to simulate SQLite writing a page
fn write_page(manager: &mut SessionManager<InMemoryFs>, page_num: u32, data: &[u8]) {
    let offset = (page_num as u64) * (SQLITE_PAGE_SIZE as u64);
    let mut page = vec![0u8; SQLITE_PAGE_SIZE];
    let len = data.len().min(SQLITE_PAGE_SIZE);
    page[..len].copy_from_slice(&data[..len]);
    manager.write_data(offset, &page).unwrap();
}

/// Helper to simulate SQLite reading a page
fn read_page(manager: &mut SessionManager<InMemoryFs>, page_num: u32) -> Vec<u8> {
    let offset = (page_num as u64) * (SQLITE_PAGE_SIZE as u64);
    manager.read_data(offset, SQLITE_PAGE_SIZE as u32).unwrap()
}

// ============================================================
// SCENARIO 1: First-time user setup
// ============================================================

#[test]
fn scenario_first_time_user_setup() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);

    // Step 1: App initializes storage on first launch
    manager.init_storage();

    // Step 2: User creates account with password
    let password = "MySecurePassword123!";
    manager.create_session(password).unwrap();
    assert_eq!(manager.state(), SessionState::Unlocked);

    // Step 3: App writes initial SQLite header (page 0)
    let sqlite_header = b"SQLite format 3\0";
    write_page(&mut manager, 0, sqlite_header);

    // Step 4: App creates initial schema (pages 1-2)
    write_page(&mut manager, 1, b"CREATE TABLE messages...");
    write_page(&mut manager, 2, b"CREATE TABLE contacts...");

    // Step 5: User closes app
    manager.flush_data().unwrap();
    manager.lock();
    assert_eq!(manager.state(), SessionState::Locked);

    // Step 6: User reopens app and logs in
    manager.unlock_session(password).unwrap();
    assert_eq!(manager.state(), SessionState::Unlocked);

    // Step 7: Verify data persisted
    let page0 = read_page(&mut manager, 0);
    assert_eq!(&page0[..16], sqlite_header);
}

// ============================================================
// SCENARIO 2: Normal chat session
// ============================================================

#[test]
fn scenario_normal_chat_session() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    // Simulate SQLite header
    write_page(&mut manager, 0, b"SQLite format 3\0");

    // User sends 100 messages over a chat session
    for i in 0..100 {
        let msg = make_message(i, &format!("Hello, this is message number {}", i));

        // SQLite would write to various pages
        let page_num = 1 + (i % 10); // Simulate writing to pages 1-10
        write_page(&mut manager, page_num, &msg);
    }

    // Periodic flush (app going to background)
    manager.flush_data().unwrap();

    // More messages
    for i in 100..150 {
        let msg = make_message(i, &format!("Another message {}", i));
        let page_num = 1 + (i % 10);
        write_page(&mut manager, page_num, &msg);
    }

    // Final flush before lock
    manager.flush_data().unwrap();
    manager.lock();

    // Reopen and verify
    manager.unlock_session("password").unwrap();

    // Read back pages
    for page_num in 1..=10 {
        let page = read_page(&mut manager, page_num);
        assert!(!page.iter().all(|&b| b == 0), "Page {} should have data", page_num);
    }
}

// ============================================================
// SCENARIO 3: Multiple users on same device (plausible deniability)
// ============================================================

#[test]
fn scenario_multiple_users_plausible_deniability() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();

    // User A: Normal user with regular chats
    let password_a = "user_a_password";
    manager.create_session(password_a).unwrap();

    write_page(&mut manager, 0, b"SQLite format 3\0");
    for i in 0..50 {
        let msg = make_message(i, "Normal chat message");
        write_page(&mut manager, 1 + (i % 5), &msg);
    }
    manager.flush_data().unwrap();
    manager.lock();

    // User B: Hidden user with sensitive chats (different password = different session)
    let password_b = "user_b_secret";
    manager.create_session(password_b).unwrap();

    write_page(&mut manager, 0, b"SQLite format 3\0");
    for i in 0..20 {
        let msg = make_message(i, "Secret message");
        write_page(&mut manager, 1 + (i % 3), &msg);
    }
    manager.flush_data().unwrap();
    manager.lock();

    // Verify: Can access User A's data with password A
    manager.unlock_session(password_a).unwrap();
    let page = read_page(&mut manager, 1);
    assert!(page.windows(6).any(|w| w == b"Normal"), "Should find User A's data");
    manager.lock();

    // Verify: Can access User B's data with password B
    manager.unlock_session(password_b).unwrap();
    let page = read_page(&mut manager, 1);
    assert!(page.windows(6).any(|w| w == b"Secret"), "Should find User B's data");
    manager.lock();

    // Verify: Wrong password fails
    assert!(manager.unlock_session("wrong_password").is_err());
}

// ============================================================
// SCENARIO 4: App crash recovery
// ============================================================

#[test]
fn scenario_app_crash_recovery() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs.clone());
    manager.init_storage();
    manager.create_session("password").unwrap();

    // Write some data
    write_page(&mut manager, 0, b"SQLite format 3\0");
    write_page(&mut manager, 1, b"Important data before crash");

    // Flush to ensure data is persisted
    manager.flush_data().unwrap();

    // Simulate crash: drop manager without proper lock
    drop(manager);

    // App restarts with same filesystem
    let mut manager2 = SessionManager::new(fs);

    // Storage already initialized
    assert!(manager2.unlock_session("password").is_ok());

    // Data should still be there
    let page = read_page(&mut manager2, 1);
    assert!(page.windows(9).any(|w| w == b"Important"));
}

// ============================================================
// SCENARIO 5: Large media file transfer
// ============================================================

#[test]
fn scenario_large_media_transfer() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    // Simulate receiving a 100KB image (25 pages)
    let image_data: Vec<u8> = (0..100 * 1024).map(|i| (i % 256) as u8).collect();

    for (i, chunk) in image_data.chunks(SQLITE_PAGE_SIZE).enumerate() {
        write_page(&mut manager, i as u32, chunk);
    }

    manager.flush_data().unwrap();
    manager.lock();

    // Verify image can be retrieved
    manager.unlock_session("password").unwrap();

    let mut retrieved = Vec::new();
    for i in 0..25 {
        let page = read_page(&mut manager, i);
        retrieved.extend_from_slice(&page);
    }

    assert_eq!(&retrieved[..image_data.len()], &image_data[..]);
}

// ============================================================
// SCENARIO 6: Long-running session with many operations
// ============================================================

#[test]
fn scenario_long_running_session() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    write_page(&mut manager, 0, b"SQLite format 3\0");

    // Simulate a day of chatting: 1000 messages
    for i in 0..1000 {
        let msg = make_message(i, &format!("Message {} with some content to make it realistic", i));
        let page_num = 1 + (i % 20); // Write across 20 pages
        write_page(&mut manager, page_num, &msg);

        // Periodic flushes (every 100 messages, like app backgrounding)
        if i % 100 == 99 {
            manager.flush_data().unwrap();
        }
    }

    // Final flush
    manager.flush_data().unwrap();

    // Verify logical size grew
    let size = manager.data_size().unwrap();
    assert!(size > 0, "Data size should be > 0");

    manager.lock();

    // Reopen and verify some data
    manager.unlock_session("password").unwrap();
    let page = read_page(&mut manager, 10);
    assert!(!page.iter().all(|&b| b == 0), "Page 10 should have data");
}

// ============================================================
// SCENARIO 7: Password change (re-encryption)
// ============================================================

#[test]
fn scenario_password_change() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();

    let old_password = "old_password";
    let new_password = "new_secure_password";

    // Create session with old password
    manager.create_session(old_password).unwrap();
    write_page(&mut manager, 0, b"SQLite format 3\0");
    write_page(&mut manager, 1, b"My precious data");
    manager.flush_data().unwrap();
    manager.lock();

    // "Change password" = create new session, copy data
    // Step 1: Unlock with old password
    manager.unlock_session(old_password).unwrap();

    // Step 2: Read all data
    let page0 = read_page(&mut manager, 0);
    let page1 = read_page(&mut manager, 1);
    manager.lock();

    // Step 3: Create new session with new password
    manager.create_session(new_password).unwrap();

    // Step 4: Write data to new session
    write_page(&mut manager, 0, &page0);
    write_page(&mut manager, 1, &page1);
    manager.flush_data().unwrap();
    manager.lock();

    // Verify: Old password still works (old session exists)
    manager.unlock_session(old_password).unwrap();
    manager.lock();

    // Verify: New password works with same data
    manager.unlock_session(new_password).unwrap();
    let page = read_page(&mut manager, 1);
    assert!(page.windows(8).any(|w| w == b"precious"));
}

// ============================================================
// SCENARIO 8: Concurrent-like access patterns
// ============================================================

#[test]
fn scenario_rapid_read_write_patterns() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    write_page(&mut manager, 0, b"SQLite format 3\0");

    // Simulate rapid interleaved reads and writes (like SQLite does)
    for i in 0..100 {
        // Write
        let msg = make_message(i, "Quick message");
        write_page(&mut manager, (i % 5) + 1, &msg);

        // Immediate read-back (SQLite verification)
        let page = read_page(&mut manager, (i % 5) + 1);
        assert!(!page.iter().all(|&b| b == 0));

        // Read from another page
        let _ = read_page(&mut manager, ((i + 2) % 5) + 1);
    }

    manager.flush_data().unwrap();
    manager.lock();

    // Verify everything persisted
    manager.unlock_session("password").unwrap();
    for page_num in 1..=5 {
        let page = read_page(&mut manager, page_num);
        assert!(!page.iter().all(|&b| b == 0), "Page {} should have data", page_num);
    }
}

// ============================================================
// SCENARIO 9: Edge case - Empty session
// ============================================================

#[test]
fn scenario_empty_session() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    // User creates account but never sends any messages
    // Just lock immediately
    manager.flush_data().unwrap();
    manager.lock();

    // Should still be able to unlock
    manager.unlock_session("password").unwrap();
    assert_eq!(manager.state(), SessionState::Unlocked);

    // Reading should return zeros
    let page = read_page(&mut manager, 0);
    assert!(page.iter().all(|&b| b == 0), "Empty session should have zero data");
}

// ============================================================
// SCENARIO 10: Stress test - Many small writes
// ============================================================

#[test]
fn scenario_many_small_writes() {
    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs);
    manager.init_storage();
    manager.create_session("password").unwrap();

    // Simulate typing indicator updates, read receipts, etc.
    // Many tiny writes to the same location
    for i in 0..500 {
        let tiny_data = format!("status:{}", i);
        manager.write_data(0, tiny_data.as_bytes()).unwrap();
    }

    manager.flush_data().unwrap();
    manager.lock();

    manager.unlock_session("password").unwrap();
    let data = manager.read_data(0, 20).unwrap();
    // Should have the last write
    assert!(data.windows(6).any(|w| w == b"status"));
}

// ============================================================
// PROD SCENARIO: Real phone test with production values
// ============================================================
// Run with: cargo test prod_real --release -- --nocapture
// This uses REAL 5-600 MB padding like on a phone!

/// Real phone scenario with PROD values (5 MB+ padding per block)
///
/// This test verifies the storage works with production settings.
/// It will write several MB to disk and take a few seconds.
///
/// Run with: `cargo test prod_real --release -- --ignored --nocapture`
/// (Without --features test-constants to use real PROD values!)
#[test]
#[ignore] // Ignored by default - run explicitly
fn prod_real_phone_session_creation() {
    use std::time::Instant;

    println!("\n=== PROD TEST: Real phone scenario ===");
    println!("Using PROD values: 5-600 MB Pareto padding, 2-256 MB blocks\n");

    let fs = InMemoryFs::new();

    // Default config uses PROD values when not using test-constants feature
    let mut manager = SessionManager::new(fs.clone());

    // Step 1: Initialize storage (2 MB addressing blob)
    let start = Instant::now();
    manager.init_storage();
    let init_time = start.elapsed();
    println!("1. init_storage(): {:?}", init_time);

    // Step 2: Create session (writes Pareto padding + root block)
    let start = Instant::now();
    manager.create_session("my_secure_password").unwrap();
    let create_time = start.elapsed();
    println!("2. create_session(): {:?}", create_time);

    // Step 3: Write a small message (stays in buffer)
    let start = Instant::now();
    manager.write_data(0, b"Hello, this is my first message!").unwrap();
    let write_time = start.elapsed();
    println!("3. write_data(32 bytes): {:?}", write_time);

    // Step 4: Flush (writes Pareto padding + encrypted block)
    let start = Instant::now();
    manager.flush_data().unwrap();
    let flush_time = start.elapsed();
    println!("4. flush_data(): {:?}", flush_time);

    // Step 5: Lock session
    let start = Instant::now();
    manager.lock();
    let lock_time = start.elapsed();
    println!("5. lock(): {:?}", lock_time);

    // Step 6: Unlock session
    let start = Instant::now();
    manager.unlock_session("my_secure_password").unwrap();
    let unlock_time = start.elapsed();
    println!("6. unlock_session(): {:?}", unlock_time);

    // Step 7: Read data back
    let start = Instant::now();
    let data = manager.read_data(0, 32).unwrap();
    let read_time = start.elapsed();
    println!("7. read_data(32 bytes): {:?}", read_time);

    // Verify data
    assert_eq!(&data[..32], b"Hello, this is my first message!");

    // Report storage usage
    let data_size = fs.get_size(FILE_DATA);
    let addr_size = fs.get_size(FILE_ADDRESSING);
    let total_mb = (data_size + addr_size) as f64 / (1024.0 * 1024.0);

    println!("\n=== Storage Report ===");
    println!("Addressing blob: {} MB", addr_size / (1024 * 1024));
    println!("Data blob: {:.1} MB", data_size as f64 / (1024.0 * 1024.0));
    println!("Total storage: {:.1} MB", total_mb);
    println!("Actual user data: 32 bytes");
    println!("Overhead ratio: {:.0}x", total_mb * 1024.0 * 1024.0 / 32.0);

    // Sanity checks
    assert!(data_size > 5 * 1024 * 1024, "Data blob should be > 5 MB (Pareto min)");
    assert!(create_time.as_secs() < 30, "Session creation should complete in < 30 seconds");

    println!("\n✓ PROD test passed! This is what will happen on a real phone.");
}

/// Worst case test: force 600 MB padding write
/// Run with: `cargo test prod_real_worst_case --release -- --ignored --nocapture`
/// WARNING: This writes 600 MB and will take ~10-30 seconds!
#[test]
#[ignore]
fn prod_real_worst_case_600mb() {
    use std::time::Instant;

    println!("\n=== PROD TEST: Worst case 600 MB write ===");
    println!("This simulates the rare (~0.5%) case of max Pareto padding\n");

    let mut fs = InMemoryFs::new();

    let start = Instant::now();

    // Force write exactly 600 MB of random padding
    let size_600mb: u64 = 600 * 1024 * 1024;
    write_random_padding(&mut fs, FILE_DATA, 0, size_600mb);

    let elapsed = start.elapsed();
    let mb_per_sec = 600.0 / elapsed.as_secs_f64();

    println!("Wrote 600 MB in {:?}", elapsed);
    println!("Speed: {:.1} MB/s", mb_per_sec);

    let actual_size = fs.get_size(FILE_DATA);
    assert_eq!(actual_size, size_600mb, "Should have written exactly 600 MB");

    // On a modern device, 600 MB should complete in under 60 seconds
    assert!(elapsed.as_secs() < 60, "600 MB write took too long: {:?}", elapsed);

    println!("\n✓ Worst case 600 MB write completed successfully!");
}

/// Stress test with PROD values - multiple flushes
/// Run with: `cargo test prod_real_multiple --release -- --ignored --nocapture`
#[test]
#[ignore]
fn prod_real_multiple_flushes() {
    use std::time::Instant;

    println!("\n=== PROD TEST: Multiple flushes ===\n");

    let fs = InMemoryFs::new();
    let mut manager = SessionManager::new(fs.clone());

    manager.init_storage();
    manager.create_session("password").unwrap();

    let start = Instant::now();

    // Simulate 5 app background/foreground cycles
    for i in 0..5 {
        manager.write_data(i * 100, format!("Message batch {}", i).as_bytes()).unwrap();
        manager.flush_data().unwrap();
        println!("Flush {}: {:?} elapsed", i + 1, start.elapsed());
    }

    manager.lock();

    let data_size = fs.get_size(FILE_DATA);
    println!("\nTotal data blob after 5 flushes: {:.1} MB", data_size as f64 / (1024.0 * 1024.0));
    println!("Expected minimum: ~35 MB (5 flushes × 7 MB each)");

    // Verify we can still read
    manager.unlock_session("password").unwrap();
    let data = manager.read_data(0, 14).unwrap();
    assert!(data.starts_with(b"Message batch "));

    println!("\n✓ PROD multiple flushes test passed!");
}
