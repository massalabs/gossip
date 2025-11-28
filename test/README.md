# Test Setup Guide

Vitest is configured to run tests in **3 different environments** based on file naming patterns.

## 📁 File Naming & Organization

Tests are routed to the correct environment using **two patterns**: suffix OR folder

### Pattern 1: File Suffix (Anywhere)

| Pattern                 | Environment            | Example                        |
| ----------------------- | ---------------------- | ------------------------------ |
| `*.browser.spec.tsx`    | **Browser** (Chromium) | `test/Button.browser.spec.tsx` |
| `*.jsdom.spec.ts`       | **jsdom**              | `test/utils.jsdom.spec.ts`     |
| `*.node.spec.ts`        | **Node**               | `test/crypto.node.spec.ts`     |
| `*.spec.ts` (no suffix) | **jsdom** (default)    | `test/helpers.spec.ts`         |

### Pattern 2: Folder Organization

| Folder              | Environment            | Example                        |
| ------------------- | ---------------------- | ------------------------------ |
| `test/browser/**/*` | **Browser** (Chromium) | `test/browser/Button.spec.tsx` |
| `test/jsdom/**/*`   | **jsdom**              | `test/jsdom/utils.spec.ts`     |
| `test/node/**/*`    | **Node**               | `test/node/crypto.spec.ts`     |
| Anywhere else       | **jsdom** (default)    | `test/helpers.spec.ts`         |

### Mix & Match!

You can use **both patterns** in the same project:

```
test/
├── browser/
│   └── components/
│       └── Button.spec.tsx          ← Runs in browser
├── node/
│   └── utils/
│       └── encryption.spec.ts       ← Runs in node
├── components/
│   └── Avatar.browser.spec.tsx      ← Runs in browser (suffix)
├── utils/
│   ├── dom.jsdom.spec.ts            ← Runs in jsdom (suffix)
│   └── helpers.spec.ts              ← Runs in jsdom (default)
└── examples/                         ← Example tests
```

## 🎯 Which Environment Should I Use?

### Use **Browser Mode** (`.browser.spec.tsx`) for:

- ✅ Component testing
- ✅ Testing real browser APIs (CSS rendering, events, focus)
- ✅ Visual and accessibility testing
- ✅ Integration tests requiring actual browser behavior

**Example:**

```tsx
// test/myComponent.browser.spec.tsx
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

it('renders correctly', async () => {
  await render(<MyComponent />);
  await expect.element(page.getByRole('button')).toBeVisible();
});
```

### Use **jsdom Mode** (`.jsdom.spec.ts`) for:

- ✅ Fast unit tests with basic DOM needs
- ✅ Testing DOM manipulation utilities
- ✅ Testing code that uses `document`, `window`, `localStorage`
- ✅ Snapshot testing

**Example:**

```ts
// test/domUtils.jsdom.spec.ts
it('creates element', () => {
  const div = document.createElement('div');
  div.textContent = 'Hello';
  expect(div.textContent).toBe('Hello');
});
```

### Use **Node Mode** (`.node.spec.ts`) for:

- ✅ Pure logic functions
- ✅ Crypto/encryption utilities
- ✅ Data transformation
- ✅ Node.js APIs (Buffer, fs, etc.)
- ✅ Fastest tests (no DOM overhead)

**Example:**

```ts
// test/encryption.node.spec.ts
import { Buffer } from 'buffer';

it('encrypts data', () => {
  const data = Buffer.from('secret');
  expect(encrypt(data)).toBeDefined();
});
```

## 🚀 Running Tests

```bash
# Run all tests (all environments)
npm test

# Run once (CI mode)
npm run test:run

# Run specific environment (convenient shortcuts)
npm run test:browser   # Only browser tests (*.browser.spec.tsx)
npm run test:jsdom     # Only explicit jsdom tests (*.jsdom.spec.ts)
npm run test:node      # Only node tests (*.node.spec.ts)
npm run test:unit      # Only default unit tests (*.spec.ts - no suffix)

# Alternative: Run specific project (manual way)
npm test -- --project=browser
npm test -- --project=jsdom
npm test -- --project=node
npm test -- --project=unit

# Run with UI
npm run test:ui

# Generate coverage
npm run test:coverage

# Watch mode (default)
npm test
```

## 📊 Current Test Status

### Suffix Pattern (examples/)

- ✅ **Browser**: 8 tests in `examples/button.browser.spec.tsx`
- ✅ **jsdom**: 3 tests in `examples/utils.jsdom.spec.ts`
- ✅ **Node**: 4 tests in `examples/crypto.node.spec.ts`
- ✅ **Unit**: 3 tests in `examples/example.spec.ts`

### Folder Pattern (browser/, jsdom/, node/)

- ✅ **Browser**: 1 test in `browser/SimpleButton.spec.tsx`
- ✅ **jsdom**: 2 tests in `jsdom/domUtils.spec.ts`
- ✅ **Node**: 3 tests in `node/pureLogic.spec.ts`

**Total**: 24 tests passing across 4 environment projects

```
✓ |browser (chromium)| test/browser/SimpleButton.spec.tsx (1 test)
✓ |browser (chromium)| test/examples/button.browser.spec.tsx (8 tests)
✓ |jsdom| test/jsdom/domUtils.spec.ts (2 tests)
✓ |jsdom| test/examples/utils.jsdom.spec.ts (3 tests)
✓ |node| test/node/pureLogic.spec.ts (3 tests)
✓ |node| test/examples/crypto.node.spec.ts (4 tests)
✓ |unit| test/examples/example.spec.ts (3 tests)

Test Files  7 passed (7)
Tests  24 passed (24)
```

## 🔧 Configuration

Tests are configured in `vite.config.ts` using the modern **`projects`** approach (replaces deprecated `workspace`):

```ts
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'browser', browser: { enabled: true, ... } } },
      { test: { name: 'jsdom', environment: 'jsdom', ... } },
      { test: { name: 'node', environment: 'node', ... } },
    ],
  },
});
```

## 📝 Best Practices

1. **Name files correctly** - The environment is determined by the filename pattern
2. **Use browser mode for components** - It catches real-world issues
3. **Use jsdom for fast unit tests** - When you don't need real browser
4. **Use node for pure logic** - Fastest option, no DOM overhead
5. **Follow accessibility patterns** - Use `getByRole`, `getByLabelText`, etc.
6. **Test user behavior** - Not implementation details

## 🔗 Resources

- [Vitest Browser Mode](https://vitest.dev/guide/browser/)
- [Component Testing Guide](https://vitest.dev/guide/browser/component-testing.html)
- [vitest-browser-react](https://www.npmjs.com/package/vitest-browser-react)

## 🐛 Troubleshooting

### Tests running in wrong environment?

- Check the filename pattern matches the conventions above
- Ensure `vite.config.ts` has the correct `include` patterns

### Browser tests failing?

- Make sure you're using `await render()` and `await expect.element()`
- Use `page.getByRole()` for queries (not `getByRole()`)

### jsdom tests have no DOM?

- Verify the file matches `*.jsdom.spec.ts` pattern
- Check that `setupFiles` includes `test/setup.ts`

### Need to debug?

- Use `headless: false` in browser config
- Add `console.log()` in tests
- Use breakpoints in VS Code
