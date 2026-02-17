# NanoClaw

AI agent assistant with multi-LLM support. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp/Discord, routes messages to an LLM provider running in Docker containers. Each group has isolated filesystem and memory. Supports Claude (default), Gemini, OpenAI, and local models via LMStudio/Ollama.

## Platform

- **OS:** Ubuntu Linux (running on `ubuntu` host)
- **Container runtime:** Docker
- **Service manager:** systemd (user service)
- **Node.js:** Managed via nvm (`~/.nvm/versions/node/`)
- **Project path:** `/home/jehangir/nanoclaw`

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `container/agent-runner/src/providers/types.ts` | LLMProvider interface and AgentMessage types |
| `container/agent-runner/src/providers/claude.ts` | Claude Agent SDK provider |
| `container/agent-runner/src/providers/langchain.ts` | LangChain provider (Gemini, OpenAI, local models) |
| `container/agent-runner/src/providers/tools.ts` | Agent tools for LangChain provider |
| `container/agent-runner/src/ipc-utils.ts` | Shared IPC utilities |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (systemd on Linux):
```bash
systemctl --user status nanoclaw       # Check status
systemctl --user restart nanoclaw      # Restart service
systemctl --user stop nanoclaw         # Stop service
systemctl --user start nanoclaw        # Start service
journalctl --user -u nanoclaw -f       # Stream journal logs
```

Service file: `~/.config/systemd/user/nanoclaw.service`

Logs:
```bash
tail -f ~/nanoclaw/logs/nanoclaw.log        # Application logs
tail -f ~/nanoclaw/logs/nanoclaw.error.log  # Error logs
```

After code changes, rebuild and restart:
```bash
npm run build && systemctl --user restart nanoclaw
```

## Container Build Cache

To force a clean rebuild:

```bash
docker builder prune -af
./container/build.sh
```

Always verify after rebuild: `docker run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

## LLM Provider Configuration

Set these in `.env` to switch providers:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `claude` | `claude` or `langchain` |
| `LLM_MODEL` | (provider default) | Model name (e.g., `gemini-2.0-flash`, `gpt-4o`) |
| `LLM_API_KEY` | — | API key for the selected model |
| `LLM_BASE_URL` | — | Base URL for OpenAI-compatible endpoints (LMStudio, Ollama) |
| `GOOGLE_API_KEY` | — | Alternative to `LLM_API_KEY` for Gemini |

Examples:
```bash
# Gemini
LLM_PROVIDER=langchain
LLM_MODEL=gemini-2.0-flash
LLM_API_KEY=your-google-api-key

# LMStudio (local)
LLM_PROVIDER=langchain
LLM_MODEL=your-model-name
LLM_BASE_URL=http://host.docker.internal:1234/v1
```
