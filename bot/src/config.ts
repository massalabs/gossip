import 'dotenv/config';

export type AIProviderType = 'echo' | 'ollama' | 'anthropic';

export interface BotConfig {
  mnemonic: string;
  botName: string;
  protocolBaseUrl: string;
  pollingIntervalMs: number;
  aiProvider: AIProviderType;
  ollama?: {
    url: string;
    model: string;
  };
  anthropic?: {
    apiKey: string;
    model: string;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): BotConfig {
  const aiProvider = optionalEnv('AI_PROVIDER', 'echo') as AIProviderType;

  const config: BotConfig = {
    mnemonic: requireEnv('BOT_MNEMONIC'),
    botName: optionalEnv('BOT_NAME', 'GossipBot'),
    protocolBaseUrl: optionalEnv(
      'PROTOCOL_URL',
      'https://api.usegossip.com/api'
    ),
    pollingIntervalMs: parseInt(optionalEnv('POLLING_INTERVAL_MS', '5000'), 10),
    aiProvider,
  };

  if (aiProvider === 'ollama') {
    config.ollama = {
      url: optionalEnv('OLLAMA_URL', 'http://localhost:11434'),
      model: optionalEnv('OLLAMA_MODEL', 'llama3.2'),
    };
  }

  if (aiProvider === 'anthropic') {
    config.anthropic = {
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      model: optionalEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
    };
  }

  return config;
}
