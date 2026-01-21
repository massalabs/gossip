import type { BotConfig } from './config.js';

export interface AIContext {
  contactName?: string;
}

export interface AIProvider {
  respond(message: string, context?: AIContext): Promise<string>;
}

/**
 * Echo AI - Simply echoes back the message (for testing)
 */
export class EchoAI implements AIProvider {
  async respond(message: string, context?: AIContext): Promise<string> {
    const greeting = context?.contactName ? `Hey ${context.contactName}! ` : '';
    return `${greeting}You said: "${message}"`;
  }
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Ollama AI - Uses local Ollama server for AI responses
 */
export class OllamaAI implements AIProvider {
  private url: string;
  private model: string;
  private conversationHistory: Map<string, ChatMessage[]> = new Map();
  private maxHistoryLength: number;

  constructor(url: string, model: string, maxHistoryLength: number = 10) {
    this.url = url;
    this.model = model;
    this.maxHistoryLength = maxHistoryLength;
  }

  private getContactKey(context?: AIContext): string {
    return context?.contactName || '_default';
  }

  private getHistory(contactKey: string): ChatMessage[] {
    if (!this.conversationHistory.has(contactKey)) {
      this.conversationHistory.set(contactKey, []);
    }
    return this.conversationHistory.get(contactKey)!;
  }

  private addToHistory(
    contactKey: string,
    role: 'user' | 'assistant',
    content: string
  ): void {
    const history = this.getHistory(contactKey);
    history.push({ role, content });

    // Keep only the last N messages
    while (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  async respond(message: string, context?: AIContext): Promise<string> {
    const contactKey = this.getContactKey(context);
    const systemPrompt = context?.contactName
      ? `You are a friendly chat bot. You are talking to ${context.contactName}. Keep responses concise.`
      : 'You are a friendly chat bot. Keep responses concise.';

    // Add user message to history
    this.addToHistory(contactKey, 'user', message);

    try {
      const response = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...this.getHistory(contactKey),
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { message: { content: string } };
      const assistantResponse = data.message.content.trim();

      // Add assistant response to history
      this.addToHistory(contactKey, 'assistant', assistantResponse);

      return assistantResponse;
    } catch (error) {
      console.error('Ollama error:', error);
      return `Sorry, I encountered an error processing your message.`;
    }
  }
}

/**
 * Anthropic AI - Uses Claude API for AI responses
 */
export class AnthropicAI implements AIProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async respond(message: string, context?: AIContext): Promise<string> {
    const systemPrompt = context?.contactName
      ? `You are a friendly chat bot named Gossip Bot. You are talking to ${context.contactName}. Keep responses concise and helpful.`
      : 'You are a friendly chat bot named Gossip Bot. Keep responses concise and helpful.';

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: message }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Anthropic request failed: ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      const textContent = data.content.find(c => c.type === 'text');
      return (
        textContent?.text.trim() || 'Sorry, I could not generate a response.'
      );
    } catch (error) {
      console.error('Anthropic error:', error);
      return `Sorry, I encountered an error processing your message.`;
    }
  }
}

/**
 * Factory function to create the appropriate AI provider
 */
export function createAIProvider(config: BotConfig): AIProvider {
  switch (config.aiProvider) {
    case 'echo':
      return new EchoAI();

    case 'ollama':
      if (!config.ollama) {
        throw new Error(
          'Ollama configuration required when AI_PROVIDER=ollama'
        );
      }
      return new OllamaAI(config.ollama.url, config.ollama.model);

    case 'anthropic':
      if (!config.anthropic) {
        throw new Error(
          'Anthropic configuration required when AI_PROVIDER=anthropic'
        );
      }
      return new AnthropicAI(config.anthropic.apiKey, config.anthropic.model);

    default:
      throw new Error(
        `Unknown AI provider: ${config.aiProvider satisfies never}`
      );
  }
}
