# Test Helpers

Shared utilities for testing: factories, mocks, and test data builders.

## Factories

### `userProfile()`

Builder pattern for creating complete UserProfile test data:

```typescript
import { userProfile } from '../helpers';

const user = userProfile()
  .userId('gossip1abc...')
  .username('Alice')
  .authMethod('password')
  .build();
```

**When to use:**

- Testing stores that need complete UserProfile objects
- Testing services that interact with user profiles
- Integration tests requiring realistic user data

**When NOT to use:**

- Simple validation tests (use minimal inline data instead)
- Tests that only need userId/username

## Mocks

### Store Mocks (`mockAccountStore`, etc.)

Mock Zustand stores for testing components:

```typescript
import { mockAccountStore } from '../helpers';
import { vi } from 'vitest';

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: vi.fn(() =>
    mockAccountStore({
      userProfile: myTestProfile,
    })
  ),
}));
```

### Router Mocks

Mock React Router for testing navigation:

```typescript
import { mockNavigate, mockLocation } from '../helpers';
```

### Capacitor Mocks

Mock Capacitor APIs for testing mobile features:

```typescript
import { mockCapacitor } from '../helpers';
```

## Usage in Tests

Import from the top-level helpers module:

```typescript
import { userProfile, mockAccountStore } from '../helpers';
```

Or import specific modules:

```typescript
import { userProfile } from '../helpers/factories';
import { mockAccountStore } from '../helpers/mocks';
```
