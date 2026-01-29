/**
 * Test Data Seeder
 *
 * Utility to generate fake discussions and messages for testing
 * app performance with large datasets.
 */

import {
  db,
  Contact,
  Discussion,
  Message,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@massalabs/gossip-sdk'
import { bech32 } from '@scure/base';

const GOSSIP_PREFIX = 'gossip';

// Prefix to identify test data - contacts with this prefix can be safely deleted
export const TEST_DATA_PREFIX = '[TEST] ';

// Sample data for realistic messages
const SAMPLE_MESSAGES = [
  'Hey! How are you doing?',
  "I'm good, thanks! What about you?",
  'Just finished work, feeling tired 😴',
  'Did you see the news today?',
  "Let's meet up this weekend!",
  'Sure, sounds great! Where?',
  'How about the coffee shop downtown?',
  'Perfect! What time works for you?',
  "Let's say 3pm?",
  'Works for me! See you there 👍',
  'Can you send me that document?',
  'Sure, sending it now',
  'Thanks! Got it',
  'No problem!',
  "What's the plan for tomorrow?",
  'Not sure yet, any suggestions?',
  'We could go hiking',
  'That sounds fun! Count me in',
  'Great, I will pick you up at 9am',
  'See you then!',
  'Hey, are you free to chat?',
  'Yes, what is up?',
  'I have some exciting news!',
  'Tell me! I am curious now',
  'I got the job! 🎉',
  'Congratulations! That is amazing!',
  'Thanks! I am so happy',
  'You deserve it! Let us celebrate',
  'Definitely! Dinner on me',
  'Deal! 🍕',
  'Quick question about the project',
  'Sure, what do you need?',
  'Can you review my code?',
  'Of course, send me the link',
  'Here it is: github.com/...',
  'Looking at it now',
  'Found a few things, let me comment',
  'Thanks for the feedback!',
  'Happy to help',
  'The changes look good now 👌',
  'Remember to bring your laptop',
  'Already packed!',
  'Great, see you at the meeting',
  'On my way now',
  'Traffic is terrible today',
  'Take your time, we will wait',
  'Thanks, almost there',
  'No rush!',
  'Just arrived',
  'Perfect timing!',
  'This is a longer message to test how the app handles messages with more content. Sometimes users write paragraphs instead of short messages.',
  '🎉🎊🥳',
  '👍',
  '❤️',
  'lol',
  'haha',
  'omg',
  'brb',
  'ttyl',
  'np',
];

const FIRST_NAMES = [
  'Alice',
  'Bob',
  'Charlie',
  'Diana',
  'Eve',
  'Frank',
  'Grace',
  'Henry',
  'Ivy',
  'Jack',
  'Kate',
  'Leo',
  'Mia',
  'Noah',
  'Olivia',
  'Paul',
  'Quinn',
  'Rose',
  'Sam',
  'Tina',
  'Uma',
  'Victor',
  'Wendy',
  'Xavier',
  'Yara',
  'Zack',
  'Anna',
  'Ben',
  'Clara',
  'David',
  'Emma',
  'Felix',
  'Gina',
  'Hugo',
  'Iris',
  'James',
  'Karen',
  'Lucas',
  'Maya',
  'Nathan',
  'Sophia',
  'Thomas',
  'Valentina',
  'William',
  'Zoe',
  'Alex',
  'Bella',
  'Chris',
  'Dani',
  'Ethan',
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
];

/**
 * Generate a random gossip user ID
 */
function generateRandomUserId(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return bech32.encode(GOSSIP_PREFIX, bech32.toWords(randomBytes));
}

/**
 * Generate a random name with test prefix
 */
function generateRandomName(): string {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${TEST_DATA_PREFIX}${firstName} ${lastName}`;
}

/**
 * Generate a random message content
 */
function getRandomMessage(): string {
  return SAMPLE_MESSAGES[Math.floor(Math.random() * SAMPLE_MESSAGES.length)];
}

/**
 * Generate a random date within a range
 */
function randomDate(start: Date, end: Date): Date {
  return new Date(
    start.getTime() + Math.random() * (end.getTime() - start.getTime())
  );
}

/**
 * Generate random public keys (fake, just for testing)
 */
function generateFakePublicKeys(): Uint8Array {
  const fakeKeys = new Uint8Array(128);
  crypto.getRandomValues(fakeKeys);
  return fakeKeys;
}

export interface SeedOptions {
  /** Number of contacts/discussions to create */
  discussionCount: number;
  /** Minimum messages per discussion */
  minMessagesPerDiscussion: number;
  /** Maximum messages per discussion */
  maxMessagesPerDiscussion: number;
  /** Number of days in the past to spread messages */
  daysBack: number;
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  discussionCount: 50,
  minMessagesPerDiscussion: 10,
  maxMessagesPerDiscussion: 200,
  daysBack: 30,
};

export interface SeedResult {
  contactsCreated: number;
  discussionsCreated: number;
  messagesCreated: number;
  duration: number;
}

/**
 * Seed the database with test data
 */
export async function seedTestData(
  ownerUserId: string,
  options: Partial<SeedOptions> = {}
): Promise<SeedResult> {
  const opts = { ...DEFAULT_SEED_OPTIONS, ...options };
  const startTime = performance.now();

  const now = new Date();
  const startDate = new Date(
    now.getTime() - opts.daysBack * 24 * 60 * 60 * 1000
  );

  let contactsCreated = 0;
  let discussionsCreated = 0;
  let messagesCreated = 0;

  // Generate all data in memory first for better performance
  const contacts: Omit<Contact, 'id'>[] = [];
  const discussions: Omit<Discussion, 'id'>[] = [];
  const messages: Omit<Message, 'id'>[] = [];

  for (let i = 0; i < opts.discussionCount; i++) {
    const contactUserId = generateRandomUserId();
    const contactName = generateRandomName();
    const createdAt = randomDate(startDate, now);

    // Create contact
    contacts.push({
      ownerUserId,
      userId: contactUserId,
      name: contactName,
      publicKeys: generateFakePublicKeys(),
      isOnline: Math.random() > 0.7,
      lastSeen: randomDate(createdAt, now),
      createdAt,
    });

    // Generate messages for this discussion
    const messageCount =
      opts.minMessagesPerDiscussion +
      Math.floor(
        Math.random() *
          (opts.maxMessagesPerDiscussion - opts.minMessagesPerDiscussion)
      );

    const discussionMessages: Omit<Message, 'id'>[] = [];

    for (let j = 0; j < messageCount; j++) {
      const isIncoming = Math.random() > 0.5;
      const timestamp = randomDate(createdAt, now);

      discussionMessages.push({
        ownerUserId,
        contactUserId,
        content: getRandomMessage(),
        type: MessageType.TEXT,
        direction: isIncoming
          ? MessageDirection.INCOMING
          : MessageDirection.OUTGOING,
        status: isIncoming ? MessageStatus.READ : MessageStatus.SENT,
        timestamp,
      });
    }

    // Sort messages by timestamp
    discussionMessages.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Get last message for discussion metadata
    const lastMessage = discussionMessages[discussionMessages.length - 1];
    const unreadCount =
      Math.random() > 0.7 ? Math.floor(Math.random() * 10) : 0;

    // Create discussion
    const isInitiated = Math.random() > 0.5;
    discussions.push({
      ownerUserId,
      contactUserId,
      direction: isInitiated
        ? DiscussionDirection.INITIATED
        : DiscussionDirection.RECEIVED,
      weAccepted: isInitiated,
      sendAnnouncement: null,
      lastMessageContent: lastMessage?.content,
      lastMessageTimestamp: lastMessage?.timestamp,
      unreadCount,
      createdAt,
      updatedAt: lastMessage?.timestamp || createdAt,
    });

    messages.push(...discussionMessages);
    messagesCreated += discussionMessages.length;
  }

  contactsCreated = contacts.length;
  discussionsCreated = discussions.length;

  // Bulk insert all data in a transaction
  await db.transaction(
    'rw',
    [db.contacts, db.discussions, db.messages],
    async () => {
      // Clear existing test data first (optional, comment out to append)
      // await db.contacts.where('ownerUserId').equals(ownerUserId).delete();
      // await db.discussions.where('ownerUserId').equals(ownerUserId).delete();
      // await db.messages.where('ownerUserId').equals(ownerUserId).delete();

      // Bulk add all data
      await db.contacts.bulkAdd(contacts as Contact[]);
      await db.discussions.bulkAdd(discussions as Discussion[]);
      await db.messages.bulkAdd(messages as Message[]);
    }
  );

  const duration = performance.now() - startTime;

  return {
    contactsCreated,
    discussionsCreated,
    messagesCreated,
    duration,
  };
}

/**
 * Clear only test data (contacts with [TEST] prefix and their associated data)
 * Real conversations are preserved.
 */
export async function clearTestData(ownerUserId: string): Promise<number> {
  let deletedCount = 0;

  await db.transaction(
    'rw',
    [db.contacts, db.discussions, db.messages],
    async () => {
      // Find all test contacts (those with [TEST] prefix in name)
      const testContacts = await db.contacts
        .where('ownerUserId')
        .equals(ownerUserId)
        .filter(contact => contact.name.startsWith(TEST_DATA_PREFIX))
        .toArray();

      const testContactUserIds = testContacts.map(c => c.userId);
      deletedCount = testContactUserIds.length;

      if (testContactUserIds.length === 0) {
        return;
      }

      // Delete messages for test contacts
      for (const contactUserId of testContactUserIds) {
        await db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .delete();
      }

      // Delete discussions for test contacts
      for (const contactUserId of testContactUserIds) {
        await db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .delete();
      }

      // Delete test contacts
      for (const contactUserId of testContactUserIds) {
        await db.contacts
          .where('[ownerUserId+userId]')
          .equals([ownerUserId, contactUserId])
          .delete();
      }
    }
  );

  return deletedCount;
}
