/**
 * WASM Bindings Barrel
 *
 * Re-exports all WASM-generated types and functions from the web target.
 * This centralizes the WASM import so the rest of the codebase uses
 * a standard relative import instead of conditional #wasm subpath imports.
 */

export { default as init } from '../assets/generated/wasm/gossip_wasm.js';
export * from '../assets/generated/wasm/gossip_wasm.js';
