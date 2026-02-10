/**
 * Message Protocol Implementation
 *
 * Provides a concrete protocol class backed by the REST implementation.
 * This uses the real Gossip API rather than a mock transport.
 */

import { RestMessageProtocol } from './rest.js';

/**
 * Create a MessageProtocol instance backed by REST.
 */
export class MessageProtocol extends RestMessageProtocol {}
