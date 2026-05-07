import { describe, it, expect, beforeEach } from 'vitest';
import {
  SelfMessageService,
  SELF_CONTACT_ID,
} from '../../src/services/selfMessage';
import {
  getTestQueries,
  clearAllTables,
  getTestStorageConfig,
} from '../testDb';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { GossipSdk } from '../../src/gossip';
import { generateMnemonic } from '../../src/crypto/bip39';
import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';

describe('SelfMessageService', () => {
  beforeEach(clearAllTables);

  it('ensureDiscussionExists creates a self discussion once and is idempotent', async () => {
    const queries = getTestQueries();
    const encKey = await generateEncryptionKey();
    const ownerUserId = 'owner-self-1';
    const service = new SelfMessageService(queries, ownerUserId, encKey);

    // First call should insert a discussion row
    await service.ensureDiscussionExists();
    const first = await queries.discussions.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(first).toBeDefined();
    expect(first?.ownerUserId).toBe(ownerUserId);
    expect(first?.contactUserId).toBe(SELF_CONTACT_ID);
    expect(first?.direction).toBe(DiscussionDirection.INITIATED);
    expect(first?.weAccepted).toBe(true);

    // Second call should not create a duplicate
    await service.ensureDiscussionExists();
    const all = await queries.discussions.getByOwner(ownerUserId);
    const selfDiscussions = all.filter(
      d => d.contactUserId === SELF_CONTACT_ID
    );
    expect(selfDiscussions).toHaveLength(1);
  });

  it('send encrypts content, stores ciphertext, and getMessages returns decrypted plaintext', async () => {
    const queries = getTestQueries();
    const encKey = await generateEncryptionKey();
    const ownerUserId = 'owner-self-enc';
    const service = new SelfMessageService(queries, ownerUserId, encKey);

    await service.ensureDiscussionExists();

    const beforeRows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(beforeRows).toHaveLength(0);

    const plaintext = 'My secret note 🌒';
    const result = await service.send(plaintext);

    // Returned message uses plaintext
    expect(result.content).toBe(plaintext);
    expect(result.direction).toBe(MessageDirection.OUTGOING);
    expect(result.type).toBe(MessageType.TEXT);
    expect(result.status).toBe(MessageStatus.SENT);
    expect(result.ownerUserId).toBe(ownerUserId);
    expect(result.contactUserId).toBe(SELF_CONTACT_ID);

    // Row in DB is encrypted (base64 ciphertext; should not equal plaintext)
    const rows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0];
    expect(stored.content).not.toBe(plaintext);
    // content is base64 "nonce || ciphertext" so should be non-empty
    expect(typeof stored.content).toBe('string');
    expect(stored.content.length).toBeGreaterThan(0);

    // getMessages() must decrypt back to plaintext and keep direction/status
    const messages = await service.getMessages();
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.id).toBe(result.id);
    expect(msg.content).toBe(plaintext);
    expect(msg.direction).toBe(MessageDirection.OUTGOING);
    expect(msg.status).toBe(MessageStatus.SENT);
  });

  it('editMessage updates content and sets edited metadata', async () => {
    const queries = getTestQueries();
    const encKey = await generateEncryptionKey();
    const ownerUserId = 'owner-self-edit';
    const service = new SelfMessageService(queries, ownerUserId, encKey);

    await service.ensureDiscussionExists();
    const sent = await service.send('original note');

    const newContent = 'edited note content';
    await service.editMessage(sent.id!, newContent);

    const messages = await service.getMessages();
    const edited = messages.find(m => m.id === sent.id);
    expect(edited).toBeDefined();
    expect(edited!.content).toBe(newContent);

    const row = await queries.messages.getById(sent.id!);
    expect(row).toBeDefined();
    expect(row!.content).not.toBe(newContent);
    const meta = row!.metadata ? JSON.parse(row!.metadata as string) : {};
    expect(meta.edited).toBe(true);
  });

  it('deleteMessage removes the row and cascades reactions', async () => {
    const queries = getTestQueries();
    const encKey = await generateEncryptionKey();
    const ownerUserId = 'owner-self-del';
    const service = new SelfMessageService(queries, ownerUserId, encKey);

    await service.ensureDiscussionExists();
    const sent = await service.send('to be deleted');

    let rows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(rows.map(r => r.id)).toContain(sent.id);

    // Attach a reaction linked via metadata.originalMessageId
    const reactionId = await queries.messages.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: 'encrypted-emoji',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      metadata: JSON.stringify({ originalMessageId: sent.id }),
    });

    await service.deleteMessage(sent.id!);

    rows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(rows.find(r => r.id === sent.id)).toBeUndefined();

    const reactions = await queries.messages.getReactionsByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(reactions.find(r => r.id === reactionId)).toBeUndefined();
  });

  it('skips messages that cannot be decrypted and still returns others', async () => {
    const queries = getTestQueries();
    const encKey = await generateEncryptionKey();
    const ownerUserId = 'owner-self-bad';

    // First service writes with one key
    const writer = new SelfMessageService(queries, ownerUserId, encKey);
    await writer.ensureDiscussionExists();
    await writer.send('ok-one');
    await writer.send('ok-two');

    // Manually insert an invalid payload row for the same owner/contact
    await queries.messages.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: 'not-base64-at-all',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    // Reader with the correct key should decrypt valid rows and skip invalid ones
    const reader = new SelfMessageService(queries, ownerUserId, encKey);
    const messages = await reader.getMessages();

    // Only the decryptable ones should be present; invalid row is skipped
    const contents = messages.map(m => m.content).sort();
    expect(contents).toEqual(['ok-one', 'ok-two']);
  });
});

describe('GossipSdk.selfMessages integration', () => {
  beforeEach(clearAllTables);

  it('exposes selfMessages after openSession and creates self discussion automatically', async () => {
    const sdk = new GossipSdk();
    await sdk.init({ storage: getTestStorageConfig() });

    const mnemonic = generateMnemonic();
    await sdk.openSession({ mnemonic });

    // Getter should be available and not throw
    const service = sdk.selfMessages;
    expect(service).toBeInstanceOf(SelfMessageService);

    const ownerUserId = sdk.userId;
    const selfDiscussion = await sdk.queries.discussions.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(selfDiscussion).toBeDefined();
    expect(selfDiscussion?.contactUserId).toBe(SELF_CONTACT_ID);

    // Send a note through the SDK facade and ensure it round-trips
    const content = 'note via sdk';
    const msg = await sdk.selfMessages.send(content);
    expect(msg.content).toBe(content);

    const all = await sdk.selfMessages.getMessages();
    expect(all.map(m => m.content)).toContain(content);

    await sdk.closeSession();
  });

  it('editMessage updates a self note via SDK', async () => {
    const sdk = new GossipSdk();
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic: generateMnemonic() });

    const original = 'note to edit';
    const msg = await sdk.selfMessages.send(original);
    expect(msg.content).toBe(original);

    const updated = 'edited note text';
    await sdk.selfMessages.editMessage(msg.id!, updated);

    const all = await sdk.selfMessages.getMessages();
    const found = all.find(m => m.id === msg.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe(updated);

    await sdk.closeSession();
  });
});
