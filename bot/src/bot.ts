import {
  gossipSdk,
  GossipDatabase,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
  type Discussion,
  type Contact,
} from 'gossip-sdk';
import { type BotConfig } from './config.js';
import { type AIProvider, createAIProvider } from './ai.js';

export class GossipBot {
  private config: BotConfig;
  private db: GossipDatabase;
  private ai: AIProvider;
  private isRunning = false;

  constructor(config: BotConfig) {
    this.config = config;
    this.db = new GossipDatabase();
    this.ai = createAIProvider(config);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Bot] Already running');
      return;
    }

    console.log('[Bot] Starting...');

    // Open database
    await this.db.open();
    console.log('[Bot] Database opened');

    // Initialize SDK
    await gossipSdk.init({
      db: this.db,
      protocolBaseUrl: this.config.protocolBaseUrl,
      config: {
        polling: {
          enabled: true,
          messagesIntervalMs: this.config.pollingIntervalMs,
          announcementsIntervalMs: this.config.pollingIntervalMs * 2,
        },
      },
    });
    console.log('[Bot] SDK initialized');

    // Setup event handlers before opening session
    this.setupEventHandlers();

    // Open session
    await gossipSdk.openSession({
      mnemonic: this.config.mnemonic,
      username: this.config.botName,
    });

    this.isRunning = true;
    console.log('[Bot] Session opened');
    console.log(`[Bot] Name: ${this.config.botName}`);
    console.log(`[Bot] User ID: ${gossipSdk.userId}`);
    console.log(`[Bot] AI Provider: ${this.config.aiProvider}`);
    console.log('[Bot] Ready and listening for messages...');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('[Bot] Not running');
      return;
    }

    console.log('[Bot] Stopping...');
    this.isRunning = false;

    try {
      await gossipSdk.closeSession();
      console.log('[Bot] Session closed');
    } catch (error) {
      console.error('[Bot] Error closing session:', error);
    }

    try {
      await this.db.close();
      console.log('[Bot] Database closed');
    } catch (error) {
      console.error('[Bot] Error closing database:', error);
    }

    console.log('[Bot] Stopped');
  }

  private setupEventHandlers(): void {
    // Handle incoming messages
    gossipSdk.on('message', (message: Message) => {
      this.onMessage(message).catch(error => {
        console.error('[Bot] Error handling message:', error);
      });
    });

    // Handle discussion requests (auto-accept)
    gossipSdk.on(
      'discussionRequest',
      (discussion: Discussion, contact: Contact) => {
        this.onDiscussionRequest(discussion, contact).catch(error => {
          console.error('[Bot] Error handling discussion request:', error);
        });
      }
    );

    // Handle errors
    gossipSdk.on('error', (error: Error, context: string) => {
      console.error(`[Bot] SDK error in ${context}:`, error.message);
    });

    // Log sent messages
    gossipSdk.on('messageSent', (message: Message) => {
      console.log(
        `[Bot] Message sent to ${message.contactUserId.slice(0, 20)}...`
      );
    });

    // Log failed messages
    gossipSdk.on('messageFailed', (message: Message, error: Error) => {
      console.error(
        `[Bot] Message failed to ${message.contactUserId}:`,
        error.message
      );
    });

    // Log session events
    gossipSdk.on('sessionBroken', (discussion: Discussion) => {
      console.log(
        `[Bot] Session broken with ${discussion.contactUserId.slice(0, 20)}...`
      );
    });

    gossipSdk.on('sessionRenewed', (discussion: Discussion) => {
      console.log(
        `[Bot] Session renewed with ${discussion.contactUserId.slice(0, 20)}...`
      );
    });
  }

  private async onDiscussionRequest(
    discussion: Discussion,
    contact: Contact
  ): Promise<void> {
    console.log(
      `[Bot] Discussion request from ${contact.name} (${contact.userId.slice(0, 20)}...)`
    );

    // Auto-accept the discussion request
    try {
      await gossipSdk.discussions.accept(discussion);
      console.log(`[Bot] Accepted discussion from ${contact.name}`);

      // Send a welcome message
      const welcomeMessage = await this.ai.respond('', {
        contactName: contact.name,
      });
      await this.sendMessage(contact.userId, `Hello! ${welcomeMessage}`);
    } catch (error) {
      console.error('[Bot] Error accepting discussion:', error);
    }
  }

  private async onMessage(message: Message): Promise<void> {
    // Only respond to incoming messages
    if (message.direction !== MessageDirection.INCOMING) {
      return;
    }

    // Skip keep-alive messages
    if (message.type === MessageType.KEEP_ALIVE) {
      return;
    }

    console.log(
      `[Bot] Received message from ${message.contactUserId.slice(0, 20)}...: "${message.content}"`
    );

    // Get contact info for context
    const contact = await gossipSdk.contacts.get(
      gossipSdk.userId,
      message.contactUserId
    );
    const contactName = contact?.name;

    // Generate AI response
    try {
      const response = await this.ai.respond(message.content, { contactName });
      await this.sendMessage(message.contactUserId, response);
    } catch (error) {
      console.error('[Bot] Error generating response:', error);
      await this.sendMessage(
        message.contactUserId,
        'Sorry, I encountered an error processing your message.'
      );
    }
  }

  private async sendMessage(
    contactUserId: string,
    content: string
  ): Promise<void> {
    const result = await gossipSdk.messages.send({
      ownerUserId: gossipSdk.userId,
      contactUserId,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    if (!result.success) {
      console.error('[Bot] Failed to send message:', result.error);
    }
  }
}
