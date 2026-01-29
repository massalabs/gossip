/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unified WASM bindings for both browser and Node.js.
 *
 * This module dynamically selects the correct generated WASM bindings at
 * runtime and re-exports the symbols that the SDK uses. It provides a single
 * import point that works in:
 * - Browsers (ESM, uses web target bindings)
 * - Node.js / jiti (CJS-generated bindings loaded via dynamic import)
 *
 * IMPORTANT:
 * - The web target (`wasm`) exposes an async default export used for init.
 * - The node target (`wasm-node`) auto-initializes on load and has no default.
 */

const isBrowser =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Load the appropriate bindings once, at module load time.
const wasmModulePromise: Promise<any> = (async () => {
  if (isBrowser) {
    // Browser / bundler: use the web-target bindings (ESM)
    return await import('../assets/generated/wasm/gossip_wasm.js');
  }

  // Node.js / jiti: load the CJS-generated bindings
  const nodeNamespace: any =
    await import('../assets/generated/wasm-node/gossip_wasm.js');

  // When importing a CJS module from ESM in Node, the exports usually appear
  // on `default`. Fall back to namespace if needed.
  const cjsExports =
    nodeNamespace && nodeNamespace.default && !nodeNamespace.__esModule
      ? nodeNamespace.default
      : (nodeNamespace.default ?? nodeNamespace);

  return cjsExports;
})();

// Await the selected module once and reuse it for all exports.
const wasm: any = await wasmModulePromise;

// Re-export the specific symbols used by the SDK.
// This keeps the surface area small and stable.
export const {
  SessionManagerWrapper,
  UserPublicKeys,
  UserSecretKeys,
  ReceiveMessageOutput,
  SendMessageOutput,
  SessionStatus,
  EncryptionKey,
  SessionConfig,
  AnnouncementResult,
  UserKeys,
  Nonce,
  aead_encrypt,
  aead_decrypt,
  generate_user_keys,
} = wasm;

/**
 * Default export:
 * - In the web target, this is the async init function (must be awaited).
 * - In the Node target, initialization happens on import and there is no
 *   default export, so we expose `undefined`.
 *
 * This matches the expectations of `wasm/loader.ts`, which treats the default
 * export as optional.
 */
const webInit = (isBrowser ? (wasm as any).default : undefined) ?? undefined;

export default webInit as ((input?: unknown) => Promise<unknown>) | undefined;
