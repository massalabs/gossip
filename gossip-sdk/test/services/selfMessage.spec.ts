import { describe, it, expect, beforeEach } from 'vitest';
import {
  SelfMessageService,
  SELF_CONTACT_ID,
} from '../../src/services/selfMessage';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import {
  getTestQueries,
  clearAllTables,
  getTestStorageConfig,
} from '../testDb';
import { GossipSdk } from '../../src/gossip';
import { generateMnemonic } from '../../src/crypto/bip39';
import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
} from '../../src/db';

function selfTextMessage(
  ownerUserId: string,
  content: string,
  timestamp: Date = new Date()
): Message {
  return {
    ownerUserId,
    contactUserId: SELF_CONTACT_ID,
    content,
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp,
  };
}

describe('SelfMessageService', () => {
  beforeEach(clearAllTables);

  it('ensureDiscussionExists creates a self discussion once and is idempotent', async () => {
    const queries = getTestQueries();
    const ownerUserId = 'owner-self-1';
    const service = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );

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

  it('send stores plaintext and getMessages returns it', async () => {
    const queries = getTestQueries();
    const ownerUserId = 'owner-self-enc';
    const service = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );

    await service.ensureDiscussionExists();

    const beforeRows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(beforeRows).toHaveLength(0);

    const plaintext = 'My secret note 🌒';
    const result = await service.send(selfTextMessage(ownerUserId, plaintext));

    // Returned message uses plaintext
    expect(result.content).toBe(plaintext);
    expect(result.direction).toBe(MessageDirection.OUTGOING);
    expect(result.type).toBe(MessageType.TEXT);
    expect(result.status).toBe(MessageStatus.SENT);
    expect(result.ownerUserId).toBe(ownerUserId);
    expect(result.contactUserId).toBe(SELF_CONTACT_ID);

    const rows = await queries.messages.getByOwnerAndContact(
      ownerUserId,
      SELF_CONTACT_ID
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0];
    expect(stored.content).toBe(plaintext);

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
    const ownerUserId = 'owner-self-edit';
    const service = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );

    await service.ensureDiscussionExists();
    const sent = await service.send(
      selfTextMessage(ownerUserId, 'original note')
    );

    const newContent = 'edited note content';
    await service.editMessage(sent.id!, newContent);

    const messages = await service.getMessages();
    const edited = messages.find(m => m.id === sent.id);
    expect(edited).toBeDefined();
    expect(edited!.content).toBe(newContent);

    const row = await queries.messages.getById(sent.id!);
    expect(row).toBeDefined();
    expect(row!.content).toBe(newContent);
    const meta = row!.metadata ? JSON.parse(row!.metadata as string) : {};
    expect(meta.edited).toBe(true);
  });

  it('deleteMessage removes the row and cascades reactions and replies', async () => {
    const queries = getTestQueries();
    const ownerUserId = 'owner-self-del';
    const service = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );

    await service.ensureDiscussionExists();
    const sent = await service.send(
      selfTextMessage(ownerUserId, 'to be deleted')
    );

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

    const replyId = await queries.messages.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: 'reply to the message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      metadata: JSON.stringify({ originalMessageId: sent.id }),
    });

    const replyToReplyId = await queries.messages.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: 'reply to the reply',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      metadata: JSON.stringify({ originalMessageId: replyId }),
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
    const reply = rows.find(r => r.id === replyId);
    expect(reply).toBeDefined();

    const replyToReply = rows.find(r => r.id === replyToReplyId);
    expect(replyToReply).toBeDefined();
    const replyToReplyMetadata = JSON.parse(replyToReply?.metadata as string);
    expect(replyToReplyMetadata.originalMessageId).toBe(replyId);

    const replyMetadata = JSON.parse(reply?.metadata as string);
    expect(reactions.find(r => r.id === reactionId)).toBeUndefined();
    expect(replyMetadata.originalMessageId).toBeUndefined();
  });

  it('getMessages returns every readable row for self chat', async () => {
    const queries = getTestQueries();
    const ownerUserId = 'owner-self-bad';

    const writer = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );
    await writer.ensureDiscussionExists();
    await writer.send(selfTextMessage(ownerUserId, 'ok-one'));
    await writer.send(selfTextMessage(ownerUserId, 'ok-two'));

    await queries.messages.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      content: 'not-base64-at-all',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    const reader = new SelfMessageService(
      queries,
      ownerUserId,
      new SdkEventEmitter()
    );
    const messages = await reader.getMessages();

    const contents = messages.map(m => m.content).sort();
    expect(contents).toEqual(['not-base64-at-all', 'ok-one', 'ok-two']);
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
    const msg = await sdk.selfMessages.send(
      selfTextMessage(ownerUserId, content)
    );
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
    const msg = await sdk.selfMessages.send(
      selfTextMessage(sdk.userId, original)
    );
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
