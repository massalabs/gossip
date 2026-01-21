# Gossip AI Bot

A Node.js bot that uses the gossip-sdk to automatically accept incoming connection requests and respond to messages using an AI provider.

## Features

- Auto-accepts incoming discussion requests
- Responds to messages using configurable AI providers:
  - **Echo** (default): Simple echo for testing
  - **Ollama**: Local AI using Ollama
  - **Anthropic**: Claude API

## Setup

### 1. Install Dependencies

From the root of the gossip-app repository:

```bash
npm install
```

Or from the bot directory:

```bash
cd bot
npm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Bot Identity - Generate a new mnemonic for the bot
BOT_MNEMONIC="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"

# Gossip Protocol Server
PROTOCOL_URL="https://api.usegossip.com/api"

# Polling interval in milliseconds
POLLING_INTERVAL_MS=5000

# AI Provider: 'echo' | 'ollama' | 'anthropic'
AI_PROVIDER=echo
```

### 3. Generate a Mnemonic (Optional)

If you need to generate a new mnemonic for the bot:

```bash
npx @scure/bip39
```

Or use any BIP39 mnemonic generator.

### 4. Get the Bot's User ID

To find out the bot's user ID (needed for users to add it as a contact):

```bash
# Using .env file
npm run get-user-id

# Or pass mnemonic directly
npm run get-user-id "your twelve word mnemonic phrase here"
```

This will output the bot's gossip user ID (e.g., `gossip1abc123...`). Share this with users who want to chat with the bot.

## Running the Bot

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

### Docker (Recommended for Production)

The easiest way to run the bot with a local AI model is using Docker Compose:

1. Create a `.env` file with your mnemonic:

```bash
echo 'BOT_MNEMONIC="your twelve word mnemonic phrase here"' > .env
```

2. Start the bot with Ollama:

```bash
docker compose up -d
```

This will:

- Start an Ollama container
- Pull the llama3.2 model automatically
- Start the bot connected to Ollama

3. View logs:

```bash
docker compose logs -f bot
```

4. Get the bot's user ID:

```bash
docker compose run --rm bot npx tsx src/get-user-id.ts
```

5. Stop everything:

```bash
docker compose down
```

#### Docker Environment Variables

You can customize the Docker deployment via environment variables:

```bash
# Required
BOT_MNEMONIC="your mnemonic here"

# Optional (with defaults)
PROTOCOL_URL=https://api.usegossip.com
POLLING_INTERVAL_MS=5000
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.2

# For Anthropic instead of Ollama
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

#### GPU Support (NVIDIA)

To enable GPU acceleration for Ollama, uncomment the GPU section in `docker-compose.yml`:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

#### Using a Different Model

To use a different Ollama model:

```bash
OLLAMA_MODEL=mistral docker compose up -d
```

Popular models: `llama3.2`, `mistral`, `phi3`, `gemma2`

## AI Provider Configuration

### Echo (Default)

Simple echo provider for testing. Just echoes back what you say.

```bash
AI_PROVIDER=echo
```

### Ollama (Local AI)

Uses a local Ollama server for AI responses.

1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull llama3.2`
3. Configure:

```bash
AI_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

### Anthropic (Claude API)

Uses the Anthropic Claude API.

1. Get an API key from https://console.anthropic.com
2. Configure:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

## Testing the Bot

1. Start the bot: `npm start`
2. Note the bot's User ID printed on startup
3. From the Gossip mobile app:
   - Add the bot's User ID as a contact
   - Start a conversation
   - Send a message
4. The bot should respond automatically

## Graceful Shutdown

Press `Ctrl+C` to stop the bot gracefully. It will close the session and database properly.

## Architecture

```
bot/
├── src/
│   ├── index.ts          # Entry point (imports fake-indexeddb first)
│   ├── bot.ts            # Main bot class with SDK integration
│   ├── ai.ts             # AI provider abstraction
│   ├── config.ts         # Configuration loader
│   └── get-user-id.ts    # Utility to derive user ID from mnemonic
├── Dockerfile            # Container build instructions
├── docker-compose.yml    # Multi-container orchestration (bot + Ollama)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## How It Works

1. **Initialization**: The bot initializes the gossip-sdk with fake-indexeddb for Node.js compatibility
2. **Session**: Opens a session using the configured mnemonic
3. **Polling**: SDK automatically polls for new announcements and messages
4. **Discussion Requests**: When someone adds the bot as a contact and starts a discussion, the bot auto-accepts
5. **Messages**: When a message is received, it's passed to the AI provider for a response
6. **Replies**: The AI response is sent back through the SDK

## Future Enhancements

- Persist session to file (avoid re-announcing on restart)
- Command system (e.g., `/help`, `/status`)
- Rate limiting
- Message history context for AI
- Web dashboard
