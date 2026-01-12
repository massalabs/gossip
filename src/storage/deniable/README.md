# Plausibly Deniable Multi-Session Encrypted Storage

A cryptographic storage system that enables multiple encrypted sessions while maintaining plausible deniability about their existence.

## 🎯 Status: In Development

This library is being implemented based on [GitHub Discussion #321](https://github.com/massalabs/gossip/discussions/321).

## 📁 Structure

```
src/storage/deniable/
├── index.ts                    # Public API (single entry point)
├── types.ts                    # Public TypeScript types
├── DeniableStorage.ts          # Main facade class
│
├── core/                       # Core logic (zero Gossip dependencies)
│   ├── AddressingBlob.ts       # Password → session location mapping
│   ├── DataBlob.ts             # Encrypted data storage
│   ├── crypto.ts               # AEAD encryption primitives
│   └── distributions.ts        # Statistical distributions (Log-Normal, Pareto)
│
├── adapters/                   # Platform-specific storage
│   ├── StorageAdapter.ts       # Adapter interface
│   ├── WebAdapter.ts           # IndexedDB (browser)
│   └── CapacitorAdapter.ts     # Native filesystem (iOS/Android)
│
└── utils/                      # Utilities
    ├── timing.ts               # Timing-safe operations
    └── memory.ts               # Secure memory wiping
```

## 🔧 Design Principles

### SDK-Ready Architecture

- **Zero coupling**: No dependencies on Gossip-specific code in `/core`
- **Adapter pattern**: Platform-agnostic via `StorageAdapter` interface
- **Single entry point**: All public API through `index.ts`
- **Ready for extraction**: Can be published as `@gossip/deniable-storage` later

### Plausible Deniability

- **No headers**: Storage looks like random noise
- **Statistical indistinguishability**: Real data vs padding uses same distributions
- **Timing-safe**: Same time for valid/invalid passwords
- **Redundant addressing**: 46 slots per session prevents enumeration

## 🚀 Quick Start (Future)

```typescript
import { DeniableStorage, WebAdapter } from './storage/deniable';

// Initialize
const storage = new DeniableStorage({
  adapter: new WebAdapter('my-storage'),
});
await storage.initialize();

// Create a session
const data = new TextEncoder().encode('secret data');
await storage.createSession('password123', data);

// Unlock a session
const result = await storage.unlockSession('password123');
if (result) {
  console.log(new TextDecoder().decode(result.data));
}

// Update a session
await storage.updateSession('password123', newData);

// Delete a session (secure wipe)
await storage.deleteSession('password123');
```

## 📊 Implementation Progress

- [x] Sprint 0.1 - File structure created
- [x] Sprint 0.2 - Types defined
- [ ] Sprint 1.1-1.5 - Addressing Blob
- [ ] Sprint 2.1-2.6 - Data Blob
- [ ] Sprint 3.1-3.5 - Manager
- [ ] Sprint 4.1-4.4 - Gossip Integration
- [ ] Sprint 5.1-5.4 - Security Hardening
- [ ] Sprint 6.1-6.4 - Testing
- [ ] Sprint 7.1-7.3 - Documentation

## 🧪 Testing Strategy

Each module will have:
- Unit tests (>90% coverage)
- Integration tests
- Statistical tests (distribution validation)
- Timing attack tests
- Cross-platform tests (Web + Capacitor)

## 📖 Technical Specification

See [GitHub Discussion #321](https://github.com/massalabs/gossip/discussions/321) for full technical details on:
- Addressing blob structure (2 MB, 65,536 slots)
- Data blob format (variable size)
- Statistical distributions (Log-Normal, Pareto)
- Cryptographic properties (AEAD, KDF)
- Deniability analysis

## 🔐 Security Properties

- **AEAD encryption**: AES-256-SIV with fresh nonces
- **Timing-safe**: Constant-time operations
- **Secure wiping**: Memory and storage overwritten
- **No metadata leakage**: Session count unknowable
- **Collision resistance**: <10⁻¹² probability with 1,024 sessions

## 🎨 Adapters

### WebAdapter (Browser)

Uses IndexedDB to store blobs. Suitable for web applications.

```typescript
const adapter = new WebAdapter('my-db-name');
```

### CapacitorAdapter (Native)

Uses native filesystem via Capacitor. Suitable for iOS/Android.

```typescript
import { Directory } from '@capacitor/filesystem';

const adapter = new CapacitorAdapter('deniable-storage', Directory.Data);
```

### Custom Adapter

Implement the `StorageAdapter` interface for custom platforms:

```typescript
class MyAdapter implements StorageAdapter {
  async initialize() { /* ... */ }
  async readAddressingBlob() { /* ... */ }
  async writeAddressingBlob(data) { /* ... */ }
  async readDataBlob() { /* ... */ }
  async writeDataBlob(data) { /* ... */ }
  async getDataBlobSize() { /* ... */ }
  async appendToDataBlob(data) { /* ... */ }
  async secureWipe() { /* ... */ }
}
```

## 📝 License

Part of the Gossip project. See main repository for license details.
