import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import type { MessageType, MessageDirection, MessageStatus } from '../db';
import { bytes } from './_helpers.js';

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    messageId: bytes('messageId'),
    content: text('content').notNull(),
    serializedContent: bytes('serializedContent'),
    type: text('type').$type<MessageType>().notNull(),
    direction: text('direction').$type<MessageDirection>().notNull(),
    status: text('status').$type<MessageStatus>().notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    metadata: text('metadata'),
    seeker: bytes('seeker'),
    replyToMsgId: bytes('replyToMsgId'),
    forwardOfContent: text('forwardOfContent'),
    forwardOfContactId: bytes('forwardOfContactId'),
    deleteOfMsgId: bytes('deleteOfMsgId'),
    editOfMsgId: bytes('editOfMsgId'),
    reactionOfMsgId: bytes('reactionOfMsgId'),
    encryptedMessage: bytes('encryptedMessage'),
    whenToSend: integer('whenToSend', { mode: 'timestamp_ms' }),
  },
  table => [
    index('messages_owner_contact_idx').on(
      table.ownerUserId,
      table.contactUserId
    ),
    index('messages_owner_status_idx').on(table.ownerUserId, table.status),
    index('messages_owner_contact_status_idx').on(
      table.ownerUserId,
      table.contactUserId,
      table.status
    ),
    index('messages_owner_seeker_idx').on(table.ownerUserId, table.seeker),
    index('messages_owner_contact_dir_idx').on(
      table.ownerUserId,
      table.contactUserId,
      table.direction
    ),
    index('messages_owner_dir_status_idx').on(
      table.ownerUserId,
      table.direction,
      table.status
    ),
    index('messages_timestamp_idx').on(table.timestamp),
    index('messages_owner_contact_msgid_idx').on(
      table.ownerUserId,
      table.contactUserId,
      table.messageId
    ),
  ]
);
