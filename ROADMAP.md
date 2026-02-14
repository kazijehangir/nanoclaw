# NanoClaw Roadmap

Project roadmap for NanoClaw. Covers the completed multi-LLM migration and all tracked improvements.

## Architecture

```
                    ┌─────────────────┐
                    │   index.ts      │
                    │  (provider-     │
                    │   agnostic)     │
                    └────────┬────────┘
                             │ LLM_PROVIDER env var
                    ┌────────┴────────┐
                    ▼                 ▼
           ┌──────────────┐  ┌───────────────┐
           │ClaudeProvider│  │LangChainProvider│
           │  claude.ts   │  │  langchain.ts  │
           └──────┬───────┘  └───────┬────────┘
                  │                  │
         Claude Agent SDK    createReactAgent()
         (full features)     ┌───────┼────────┐
                             ▼       ▼        ▼
                          Gemini  OpenAI   LMStudio
                                         /Ollama
```

---

## Completed

### Multi-LLM Provider Migration ✅

<details>
<summary>Phase 1–5 + bug fixes (click to expand)</summary>

#### Phase 1: Provider Interface & Types

Defined the `LLMProvider` interface, `AgentMessage`, and `AgentInput` types in `providers/types.ts`. Extracted IPC file-writing logic into shared `ipc-utils.ts` so both the MCP server and LangChain tools can use it.

**Commit:** `3a4eb11` — `feat: add LLMProvider interface and shared IPC utilities`

**Files created:**
- `container/agent-runner/src/providers/types.ts`
- `container/agent-runner/src/ipc-utils.ts`

#### Phase 2: Claude Provider Extraction

Extracted the existing Claude Agent SDK `query()` call from `index.ts` into `ClaudeProvider`. Refactored `index.ts` to use the `LLMProvider` interface. Zero behavior change — all 139 host-side tests passing.

**Commit:** `4705099` — `feat: extract ClaudeProvider and refactor index.ts to use LLMProvider`

**Files created:**
- `container/agent-runner/src/providers/claude.ts`

**Files modified:**
- `container/agent-runner/src/index.ts` — uses `createProvider()` factory

#### Phase 3: LangChain Provider

Implemented `LangChainProvider` using `createReactAgent` from `@langchain/langgraph`. Supports Gemini (`ChatGoogleGenerativeAI`), OpenAI (`ChatOpenAI`), and OpenAI-compatible endpoints (LMStudio, Ollama). Implemented 14 agent tools (bash, file I/O, glob, grep, web fetch, and all IPC tools).

**Commit:** `0a9100f` — `feat: add LangChain provider with multi-model support`

**Files created:**
- `container/agent-runner/src/providers/langchain.ts`
- `container/agent-runner/src/providers/tools.ts`

#### Phase 4: Host-Side Configuration

Added `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` to `config.ts`. Expanded `readSecrets()` in `container-runner.ts` to pass provider-specific env vars. Added `--add-host=host.docker.internal:host-gateway` for Docker on Linux (macOS handles this automatically).

**Commit:** `407e8b3` — `feat: add host-side LLM provider configuration`

**Files modified:**
- `src/config.ts`
- `src/container-runner.ts`

#### Phase 5: Documentation

Updated `CLAUDE.md` with provider architecture documentation. Updated `README.md` with LLM provider configuration section, feature comparison table, and FAQ entry.

**Commits:**
- `682ebeb` — `docs: update CLAUDE.md with multi-LLM provider documentation`
- `75c8343` — `docs: update README.md with multi-LLM provider support`

#### Bug Fixes (Post-Migration)

| Commit | Fix |
|--------|-----|
| `4c1e942` | Make `ClaudeProvider` import dynamic to prevent SDK auth check when using LangChain |
| `563235b` | Set LLM config vars in `process.env` before provider selection |
| `5cdda6b` | Downgrade zod to v3 for LangChain compatibility (temporary) |
| `70519ae` | Upgrade to LangChain 1.x + zod 4, fix `HookCallback` type signatures |

The zod version conflict (`claude-agent-sdk` needs zod 4, old LangChain needed zod 3) was the main blocker for Docker builds. Resolved by upgrading all LangChain packages to the 1.x/2.x line which natively supports zod 4.

</details>

### Persistent Memory & Reminders ✅

- Added `update_memory` tool with multi-user isolation (writes to `users/{user}/CLAUDE.md`).
- System prompt includes explicit instructions for `schedule_task` / `list_tasks` for reminders.

---

## In Progress

### End-to-End Verification 🔄

The Docker container should now build cleanly. These tests need to be run:

- [ ] **Docker build** — `cd container && ./build.sh`
- [ ] **Claude provider** — Verify default behavior is unchanged (no config changes needed)
- [ ] **Gemini** — Set `LLM_PROVIDER=langchain`, `LLM_MODEL=gemini-2.0-flash`, `LLM_API_KEY=<key>` and verify tool use works
- [ ] **LMStudio** — Set `LLM_PROVIDER=langchain`, `LLM_BASE_URL=http://host.docker.internal:1234/v1` and verify local model works

---

## Future Work

Organized by priority. Each section is independent and can be worked in any order within a tier.

### P0: Security Hardening

#### Credential Isolation

**Problem:** Anthropic API credentials are mounted into containers so Claude Code can authenticate. The agent can discover these via Bash or file operations (acknowledged in `docs/SECURITY.md`). This means any prompt injection attack can exfiltrate API keys.

**Approaches:**

| Approach | Effort | Trade-off |
|----------|--------|-----------|
| **Host-side auth proxy** — Route all Claude API calls through a host-side proxy that injects auth headers. Container never sees credentials. | Medium | Requires intercepting SDK traffic; may break with SDK updates |
| **Scoped API keys** — Use keys with minimal permissions and short TTL | Low | Requires Anthropic to support scoped keys (not available today) |
| **Credential vault with lease** — Mount a UNIX socket that returns a short-lived token on request | High | Most secure but complex plumbing |

**Recommended:** Host-side auth proxy. Even a simple `socat` or `nginx` reverse proxy on `host.docker.internal` that adds the `x-api-key` header would eliminate credential exposure entirely.

**Files involved:** `src/container-runner.ts` (mount/env setup), `container/agent-runner/src/providers/claude.ts` (SDK init)

#### Container Network Isolation

Containers currently have **unrestricted outbound network access**. This creates a prompt injection → SSRF attack vector: a malicious webpage fetched via `web_fetch` or `bash` could instruct the agent to scan or access internal network services (routers, NAS, local APIs).

**Approaches:**

| Approach | Effort | Trade-off |
|----------|--------|-----------|
| **iptables in container** — Block RFC 1918 ranges (10.x, 172.16.x, 192.168.x), whitelist only `host.docker.internal` for LLM endpoint | Low | Agent can browse the internet but not the LAN |
| **Docker `--network=none`** — Full network isolation with an explicit HTTP proxy for allowed traffic | Medium | Requires a proxy; breaks web tools unless whitelisted |
| **Remove web tools for untrusted groups** — Strip `WebFetch`/`web_fetch` from non-main group tool lists | Low | Untrusted groups lose web access entirely |
| **DNS filtering** — Block resolution of internal hostnames | Low | Doesn't prevent direct IP access |

**Recommended:** iptables rules blocking private IP ranges, with an explicit allow for `host.docker.internal` when `LLM_BASE_URL` points to a local model.

#### Container Resource Limits

**Problem:** No `--memory` or `--cpus` flags in `container-runner.ts`. A runaway agent (infinite Bash loop, memory leak from large file reads) can consume unbounded host resources. With 5 concurrent container slots, this could exhaust the host.

**Fix:** Add `--memory=2g --cpus=2` (or configurable equivalents) to the `docker run` invocation. Consider also `--pids-limit=256` to prevent fork bombs.

**Files involved:** `src/container-runner.ts` (Docker args assembly)

---

### P1: Reliability

#### Per-Group Rate Limiting

**Problem:** A single group can monopolize all 5 container slots indefinitely. Rapid-fire messages can spawn back-to-back containers with no cooldown. There's no protection against a group (or prompt injection) triggering an agent loop.

**Fix:** Add per-group cooldown (e.g., min 10s between invocations) and a max-concurrent-per-group limit (e.g., 1). Track invocation count per group per hour and reject above threshold.

**Files involved:** `src/group-queue.ts`

#### Database Backups

**Problem:** SQLite at `data/nanoclaw.db` is the single source of truth for messages, tasks, sessions, and group registrations. No backup mechanism exists. Corruption or accidental deletion means total data loss.

**Fix:** Periodic backup using SQLite's `.backup` API or `VACUUM INTO`. Rotate backups (keep last N). Could be a simple cron task or built into the main loop.

**Files involved:** `src/db.ts`, potentially a new `src/backup.ts`

#### Duplicate Task Run Prevention

**Problem:** If the host process restarts while a scheduled task is executing, the task may run again because `next_run` hasn't been updated yet. One-time tasks (`schedule_type='once'`) with `null` `next_run` remain in the DB forever.

**Fix:** Set `status='running'` before execution, revert on crash recovery. Auto-delete completed one-time tasks after a retention period.

**Files involved:** `src/task-scheduler.ts`, `src/db.ts`

---

### P2: Test Coverage

Current coverage is ~40%, concentrated in DB, IPC auth, and container timeout logic. The following areas are untested and ordered by risk.

#### Mount Security (`mount-security.ts`) — HIGH PRIORITY

419 lines, zero tests. This is a security boundary that validates what host paths are exposed to containers. Test cases needed:

- [ ] Symlink resolution prevents traversal attacks
- [ ] Blocked patterns (`.ssh`, `.env`, `credentials`, etc.) are rejected
- [ ] Container path validation rejects `..` and absolute paths
- [ ] `nonMainReadOnly` forces read-only for non-main groups
- [ ] Missing allowlist file blocks all mounts
- [ ] Edge cases: empty allowlist, duplicate entries, nested paths

#### Group Queue (`group-queue.ts`)

Concurrency control, retry logic, and task prioritization. Test cases:

- [ ] Max concurrent containers enforced
- [ ] Tasks prioritized over messages in drain order
- [ ] Exponential backoff timing (5 retries, 5s → 80s)
- [ ] Follow-up message piping via IPC
- [ ] `_close` sentinel stops container
- [ ] Waiting groups drained when slots free up

#### Container Runner (`container-runner.ts`) — Expand Existing

Current tests only cover timeout behavior. Add:

- [ ] Mount assembly (main vs non-main, additional mounts)
- [ ] Secret passing via stdin (secrets not in env or mounts)
- [ ] Streaming output protocol (sentinel marker parsing)
- [ ] `activeUser` serialization into `ContainerInput`
- [ ] Session ID extraction and persistence

#### Container-Side Tools (`providers/tools.ts`)

- [ ] `update_memory`: writes to `CLAUDE.md` (no user) vs `users/{user}/CLAUDE.md` (with user)
- [ ] `update_memory`: directory creation for new users
- [ ] `bash`: timeout enforcement, output truncation
- [ ] `edit_file`: string replacement correctness
- [ ] `schedule_task`: cron/interval/once IPC file generation

#### LangChain Provider (`providers/langchain.ts`)

- [ ] Model selection logic (Gemini prefix, base URL, fallback to OpenAI)
- [ ] `activeUser` passed through to tool creation
- [ ] System prompt includes user memory when `activeUser` is set
- [ ] `onMemoryUpdate` callback invoked on memory tool use

#### Task Scheduler (`task-scheduler.ts`)

- [ ] Cron next-run computation with timezone
- [ ] Interval re-scheduling after execution
- [ ] One-time task completion
- [ ] Context mode (`group` vs `isolated`) passed correctly

#### Channel Implementations

- [ ] WhatsApp: reconnection logic, QR re-auth, group metadata sync
- [ ] Discord: DM auto-registration, guild name discovery, JID format

---

### P3: Developer Experience

#### `.env.example`

No configuration template exists. Users must read docs to discover available variables. Add `.env.example` with all supported variables, commented defaults, and provider-specific examples.

#### Container Startup Overhead

The Dockerfile recompiles TypeScript on every container start (`npx tsc` in the entrypoint). This adds ~5 seconds per invocation.

**Fix:** Pre-compile during `docker build`. Only recompile at runtime if source is mounted (dev mode). Use a hash check to skip recompilation when source hasn't changed.

**Files involved:** `container/Dockerfile`, `container/agent-runner/entrypoint.sh`

#### Observability

No metrics, no health endpoint, no way to know queue depth, container counts, error rates, or response latency. The process runs as a `launchd` service with only log files for visibility.

**Options (pick one):**

| Approach | Effort | Trade-off |
|----------|--------|-----------|
| **Periodic stats log line** — Log queue depth, active containers, messages/min every 60s | Low | Grep-able but not queryable |
| **Health endpoint** — Simple HTTP server on localhost with JSON stats | Medium | Can hook into monitoring tools |
| **Structured metrics file** — Write JSON stats to `data/metrics.json` periodically | Low | Readable by external tools without a server |

**Recommended:** Start with periodic stats log lines (low effort, immediate value), upgrade to health endpoint later if needed.

---

### P4: Features

#### Session Persistence for LangChain Provider

The LangChain provider starts a fresh conversation each time a new container is spawned. Within a single container lifecycle, follow-up messages maintain context via IPC. But once the container exits (idle timeout or host restart), context is lost.

**Approach:** Save/load LangGraph checkpoints to the group folder. Restore on container start if a checkpoint exists.

#### MCP Server Support for LangChain Provider

The Claude provider connects to MCP servers (custom tool servers). The LangChain provider only uses its built-in tools. Adding MCP client support would give LangChain access to the same custom tool ecosystem.

#### Streaming Responses for LangChain Provider

The current LangChain provider waits for the full agent response before yielding. Adding streaming would improve perceived latency for long-running agent tasks.

---

## Known Limitations

| Limitation | Details |
|-----------|---------|
| **Agent Teams** | Not available for non-Claude providers. Claude's agent teams (`Task`, `TeamCreate`, etc.) are proprietary to the Claude Agent SDK. |
| **Session resume** | Not supported for LangChain provider. Context persists within a container lifecycle but is lost on container exit. |
| **Tool quality** | Local models with weak function-calling may not use tools reliably. Gemini and GPT-4o work well. |
| **MCP servers** | Only the Claude provider connects to MCP servers. LangChain uses built-in tools only. |

---

## Configuration Reference

```bash
# .env file
LLM_PROVIDER=claude         # "claude" (default) or "langchain"
LLM_MODEL=gemini-2.0-flash  # Model name (provider-specific)
LLM_API_KEY=your-api-key    # API key for the model provider
LLM_BASE_URL=               # Base URL for OpenAI-compatible endpoints
GOOGLE_API_KEY=              # Alternative to LLM_API_KEY for Gemini
```
