/**
 * Service Worker entry for Gossip SDK
 *
 * This entry is safe for use in service workers and other lightweight
 * environments where the full SDK (including WASM bindings) is not needed.
 *
 * It re-exports only the message protocol types and helpers required by
 * the Gossip PWA service worker.
 */

export {
  RestMessageProtocol,
  type EncryptedMessage,
  type IMessageProtocol,
  type MessageProtocolResponse,
  type BulletinItem,
} from './api/messageProtocol';
