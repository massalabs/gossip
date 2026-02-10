/**
 * Test Mocks
 *
 * Only MockMessageProtocol is needed - it provides an in-memory
 * implementation to avoid network calls during tests.
 *
 * SessionModule uses real WASM - no mock needed since WASM works in Node.
 */
export { MockMessageProtocol } from './mockMessageProtocol.js';
