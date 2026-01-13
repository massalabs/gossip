# WASM Migration Analysis for Deniable Storage

## Executive Summary

After analyzing the deniable storage implementation, several critical operations should be moved to WASM (Rust) for **reliability, performance, and security**. This document outlines what should be migrated and why.

---

## 🔴 HIGH PRIORITY - Should Move to WASM

### 1. **Statistical Distributions** (`core/distributions.ts`)

**Current:** JavaScript Box-Muller & Pareto implementation
**Location:** `src/storage/deniable/core/distributions.ts`

**Why move to WASM:**

- ✅ **Performance:** Called frequently (every block/padding generation)
- ✅ **Reliability:** Floating-point precision issues in JS
- ✅ **Security:** Rust's deterministic math prevents timing variations
- ✅ **Quality:** Better random number generation with `rand` crate

**Functions to migrate:**

```typescript
generateBlockSize(): number  // Log-Normal distribution
generatePaddingSize(): number // Pareto distribution
```

**Rust equivalent:**

```rust
// Using `rand` and `rand_distr` crates
pub fn generate_block_size() -> usize {
    let log_normal = LogNormal::new(mu, sigma).unwrap();
    let size = rng.sample(log_normal);
    size.clamp(MIN_SIZE, MAX_SIZE) as usize
}

pub fn generate_padding_size() -> usize {
    let pareto = Pareto::new(X_MIN, ALPHA).unwrap();
    let size = rng.sample(pareto);
    size.min(MAX_SIZE) as usize
}
```

**Impact:** 10-50x performance improvement for blob assembly

---

### 2. **Secure Memory Operations** (`utils/memory.ts`)

**Current:** JavaScript buffer overwrites
**Location:** `src/storage/deniable/utils/memory.ts`

**Why move to WASM:**

- ✅ **Security:** JS can't prevent compiler optimizations removing "dead" overwrites
- ✅ **Reliability:** Rust's `zeroize` crate provides guaranteed memory wiping
- ✅ **Hardware:** Can use CPU instructions (e.g., `memset_s`)

**Functions to migrate:**

```typescript
secureWipe(buffer: Uint8Array): void
secureZero(buffer: Uint8Array): void
wipeAll(...buffers: Uint8Array[]): void
```

**Rust equivalent:**

```rust
use zeroize::Zeroize;

pub fn secure_wipe(mut buffer: &mut [u8]) {
    // Pass 1: Random
    getrandom::getrandom(&mut buffer).unwrap();
    // Pass 2-4: Zeros, ones, random
    buffer.zeroize(); // Compiler-guaranteed
    buffer.fill(0xFF);
    getrandom::getrandom(&mut buffer).unwrap();
    buffer.zeroize();
}
```

**Impact:** Guaranteed memory wiping (critical for security)

---

### 3. **Timing-Safe Comparison** (`utils/timing.ts`)

**Current:** JavaScript XOR-based comparison
**Location:** `src/storage/deniable/utils/timing.ts`

**Why move to WASM:**

- ✅ **Security:** JS JIT optimizations can introduce timing variations
- ✅ **Reliability:** Rust's `subtle` crate provides constant-time guarantees
- ✅ **Performance:** SIMD operations in Rust

**Functions to migrate:**

```typescript
timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
```

**Rust equivalent:**

```rust
use subtle::ConstantTimeEq;

pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}
```

**Impact:** Guaranteed constant-time operation (prevents side-channel attacks)

---

## 🟡 MEDIUM PRIORITY - Consider Moving to WASM

### 4. **Block Scanning** (in `DeniableStorage.unlockSession()`)

**Current:** JavaScript linear scan through data blob
**Location:** `src/storage/deniable/DeniableStorage.ts:151-182`

**Why move to WASM:**

- ✅ **Performance:** Scanning 600MB+ of data
- ✅ **Efficiency:** SIMD can scan 16-32 bytes at once
- ⚠️ **Complexity:** Moderate implementation effort

**Current code:**

```typescript
for (let i = searchStart; i < searchEnd - 4; i++) {
  const view = new DataView(dataBlob.buffer, i, 4);
  const size = view.getUint32(0, false);
  if (
    size === sessionAddress.blockSize &&
    size > 20 &&
    size < 256 * 1024 * 1024
  ) {
    blockStart = i;
    break;
  }
}
```

**Rust equivalent:**

```rust
pub fn find_block_header(
    blob: &[u8],
    start: usize,
    end: usize,
    target_size: u32
) -> Option<usize> {
    blob[start..end]
        .windows(4)
        .position(|window| {
            let size = u32::from_be_bytes([window[0], window[1], window[2], window[3]]);
            size == target_size && size > 20 && size < 256 * 1024 * 1024
        })
        .map(|pos| start + pos)
}
```

**Impact:** 5-10x faster block discovery

---

### 5. **Slot Derivation** (`core/AddressingBlob.ts`)

**Current:** Multiple Argon2id calls + JS array operations
**Location:** `src/storage/deniable/core/AddressingBlob.ts:60-123`

**Why move to WASM:**

- ✅ **Performance:** Called on every session operation
- ✅ **Atomicity:** Single WASM call vs multiple round-trips
- ⚠️ **Complexity:** Already uses WASM crypto, just needs aggregation

**Current code:**

```typescript
const indices: number[] = [];
// ... multiple WASM calls with counter ...
while (indices.length < SLOTS_PER_SESSION) {
  const key = await generateEncryptionKeyFromSeed(
    `${password}:${counter}`,
    salt
  );
  // Process bytes...
}
```

**Rust equivalent:**

```rust
pub fn derive_slot_indices(password: &str, slot_count: usize) -> Vec<u16> {
    let mut indices = HashSet::new();
    let mut counter = 0;

    while indices.len() < 46 {
        let key = EncryptionKey::from_seed(&format!("{}:{}", password, counter), salt);
        // Extract indices from key bytes
        // ...
        counter += 1;
    }

    indices.into_iter().collect()
}
```

**Impact:** 2-5x faster + atomic operation

---

## 🟢 LOW PRIORITY - Keep in JavaScript

### 6. **Validation Functions** (`utils/validation.ts`)

**Keep in JS because:**

- ❌ Simple string/type checks
- ❌ Better error messages in JS
- ❌ No performance benefit from WASM
- ❌ Easier to maintain and modify

### 7. **DeniableStorage Orchestration** (`DeniableStorage.ts`)

**Keep in JS because:**

- ❌ High-level business logic
- ❌ Better suited for async/await patterns
- ❌ Easier debugging and error handling
- ❌ Adapter integration better in JS

---

## 📊 Performance Impact Estimation

| Operation              | Current (JS)           | With WASM            | Speedup           |
| ---------------------- | ---------------------- | -------------------- | ----------------- |
| Generate distributions | ~100 µs                | ~5-10 µs             | **10-20x**        |
| Secure memory wipe     | ~1 ms (not guaranteed) | ~200 µs (guaranteed) | **5x + security** |
| Timing-safe compare    | ~10 µs (variable)      | ~5 µs (constant)     | **2x + security** |
| Block scanning (600MB) | ~50-100 ms             | ~5-10 ms             | **10x**           |
| Slot derivation        | ~5-10 ms               | ~1-2 ms              | **5x**            |

**Total Impact:** 20-50% faster session operations, significantly better security guarantees

---

## 🎯 Recommended Implementation Plan

### Phase A: Critical Security (Week 1)

1. ✅ `secure_wipe()` - Guaranteed memory wiping
2. ✅ `timing_safe_equal()` - Constant-time comparison
3. ✅ `generate_block_size()` / `generate_padding_size()` - Better RNG

### Phase B: Performance (Week 2)

4. ✅ `find_block_header()` - Fast block scanning
5. ✅ `derive_slot_indices()` - Atomic slot derivation

### Phase C: Polish (Week 3)

6. ✅ Integration tests
7. ✅ Benchmark comparisons
8. ✅ Documentation

---

## 🔧 Implementation Notes

### Required Rust Crates

```toml
[dependencies]
rand = "0.8"
rand_distr = "0.4"  # For Log-Normal and Pareto
zeroize = "1.7"     # For secure memory wiping
subtle = "2.5"      # For constant-time operations
getrandom = "0.2"   # For cryptographic RNG
```

### WASM Bindings

```rust
#[wasm_bindgen]
pub fn generate_block_size() -> u32 { /* ... */ }

#[wasm_bindgen]
pub fn generate_padding_size() -> u32 { /* ... */ }

#[wasm_bindgen]
pub fn secure_wipe(buffer: &mut [u8]) { /* ... */ }

#[wasm_bindgen]
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool { /* ... */ }

#[wasm_bindgen]
pub fn find_block_header(blob: &[u8], start: usize, end: usize, target_size: u32) -> Option<usize> { /* ... */ }

#[wasm_bindgen]
pub fn derive_slot_indices(password: &str) -> Vec<u16> { /* ... */ }
```

---

## ✅ Summary

**Must migrate to WASM:**

1. Statistical distributions (performance + reliability)
2. Secure memory operations (security guarantee)
3. Timing-safe comparison (security guarantee)

**Should migrate to WASM:** 4. Block scanning (performance) 5. Slot derivation (performance + atomicity)

**Keep in JavaScript:**

- Validation (simplicity)
- Orchestration (maintainability)

**Total WASM functions to add:** 5-6 new exports
**Estimated effort:** 2-3 weeks
**Performance gain:** 20-50% faster, significantly more secure
