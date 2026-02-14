<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  AI agent assistant that runs securely in containers. Supports Claude, Gemini, OpenAI, and local models. Lightweight and built to be understood and customized for your own needs.
</p>

<p align="center">
  <a href="README_zh.md">中文</a> ·
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord"></a>
</p>

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run in actual Linux containers with filesystem isolation, not behind permission checks.

## Quick Start

```bash
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup, service configuration.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Secure by isolation.** Agents run in Docker containers. They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for one user.** This isn't a framework. It's working software that fits my exact needs. You fork it and have Claude Code make it match your exact needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that this is safe.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors shouldn't add features (e.g. support for Telegram) to the codebase. Instead, they contribute [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** Defaults to Claude Agent SDK (Claude Code), with a pluggable LLM provider system supporting Gemini, OpenAI, and local models. The harness matters — a bad harness makes even smart models seem dumb, a good harness gives them superpowers.

## What It Supports

- **WhatsApp I/O** - Message your agent from your phone
- **Multi-LLM support** - Claude (default), Gemini, OpenAI, or local models via LMStudio/Ollama
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted
- **Main channel** - Your private channel (self-chat) for admin control; every other group is completely isolated
- **Scheduled tasks** - Recurring jobs that run your agent and can message you back
- **Web access** - Search and fetch content
- **Container isolation** - Agents sandboxed in Docker containers (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks (Claude provider only)
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd love to see:

**Communication Channels**
- `/add-telegram` - Add Telegram as channel. Should give the user option to replace WhatsApp or add as additional channel. Also should be possible to add it as a control channel (where it can trigger actions) or just a channel that can be used in actions triggered elsewhere
- `/add-slack` - Add Slack
- `/add-discord` - Add Discord

**Platform Support**
- `/setup-windows` - Windows via WSL2 + Docker

**Session Management**
- `/add-clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download) (for default Claude provider)
- [Docker](https://docker.com/products/docker-desktop)

## LLM Provider Configuration

NanoClaw defaults to Claude, but you can switch to other models by setting environment variables in `.env`:

### Claude (Default)

No additional configuration needed. Uses `CLAUDE_CODE_OAUTH_TOKEN` from `.env`.

### Gemini

```bash
LLM_PROVIDER=langchain
LLM_MODEL=gemini-2.0-flash
LLM_API_KEY=your-google-api-key
```

### OpenAI

```bash
LLM_PROVIDER=langchain
LLM_MODEL=gpt-4o
LLM_API_KEY=your-openai-api-key
```

### Local Models (LMStudio / Ollama)

```bash
LLM_PROVIDER=langchain
LLM_MODEL=your-model-name
LLM_BASE_URL=http://host.docker.internal:1234/v1
```

> **Note:** `host.docker.internal` lets the Docker container reach your host machine where LMStudio/Ollama runs. After changing providers, rebuild the container: `cd container && ./build.sh`

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `claude` | `claude` or `langchain` |
| `LLM_MODEL` | _(provider default)_ | Model name |
| `LLM_API_KEY` | — | API key for the model provider |
| `LLM_BASE_URL` | — | Base URL for OpenAI-compatible endpoints |
| `GOOGLE_API_KEY` | — | Alternative to `LLM_API_KEY` for Gemini |

**Provider feature comparison:**

| Feature | Claude | LangChain (Gemini/OpenAI/Local) |
|---------|--------|----------------------------------|
| Tool use (bash, files, web) | ✅ | ✅ |
| IPC tools (messaging, scheduling) | ✅ | ✅ |
| Session resume | ✅ | ❌ (planned) |
| Agent Swarms | ✅ | ❌ |
| MCP server support | ✅ | ❌ |

## Architecture

```
WhatsApp/Discord --> SQLite --> Polling loop --> Container (LLM Provider) --> Response
```

Single Node.js process. Agents execute in isolated Linux containers with mounted directories. Per-group message queue with concurrency control. IPC via filesystem. The LLM provider is selected at container startup based on the `LLM_PROVIDER` environment variable.

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/whatsapp.ts` - WhatsApp connection, auth, send/receive
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `container/agent-runner/src/providers/` - LLM provider implementations
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why WhatsApp and not Telegram/Signal/etc?**

Because I use WhatsApp. Fork it and run a skill to change it. That's the whole point.

**Why Docker?**

Docker provides cross-platform support (macOS and Linux), a large ecosystem, and mature tooling. Docker Desktop on macOS uses a lightweight Linux VM similar to other container solutions.

**Can I run this on Linux?**

Yes. NanoClaw uses Docker, which works on both macOS and Linux. Just install Docker and run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize it to so that the code matches exactly what they want rather than configuring a generic system. If you like having config files, tell Claude to add them.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**Why isn't the setup working for me?**

I don't know. Run `claude`, then run `/debug`. If claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**Can I use a different AI model?**

Yes. Set `LLM_PROVIDER=langchain` in your `.env` along with `LLM_MODEL` and `LLM_API_KEY`. Supports Gemini, OpenAI, and local models via LMStudio/Ollama. See [LLM Provider Configuration](#llm-provider-configuration) for details. Note that some features (Agent Swarms, session resume) are Claude-only.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. That's it.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VGWXrf8x).

## License

MIT
