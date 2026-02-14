# Multi-LLM Provider Roadmap

Status of the multi-LLM provider migration for NanoClaw. Work is tracked on the `feature/multi-llm-provider` branch.

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

## Completed

### Phase 1: Provider Interface & Types ✅

Defined the `LLMProvider` interface, `AgentMessage`, and `AgentInput` types in `providers/types.ts`. Extracted IPC file-writing logic into shared `ipc-utils.ts` so both the MCP server and LangChain tools can use it.

**Commit:** `3a4eb11` — `feat: add LLMProvider interface and shared IPC utilities`

**Files created:**
- `container/agent-runner/src/providers/types.ts`
- `container/agent-runner/src/ipc-utils.ts`

---

### Phase 2: Claude Provider Extraction ✅

Extracted the existing Claude Agent SDK `query()` call from `index.ts` into `ClaudeProvider`. Refactored `index.ts` to use the `LLMProvider` interface. Zero behavior change — all 139 host-side tests passing.

**Commit:** `4705099` — `feat: extract ClaudeProvider and refactor index.ts to use LLMProvider`

**Files created:**
- `container/agent-runner/src/providers/claude.ts`

**Files modified:**
- `container/agent-runner/src/index.ts` — uses `createProvider()` factory

---

### Phase 3: LangChain Provider ✅

Implemented `LangChainProvider` using `createReactAgent` from `@langchain/langgraph`. Supports Gemini (`ChatGoogleGenerativeAI`), OpenAI (`ChatOpenAI`), and OpenAI-compatible endpoints (LMStudio, Ollama). Implemented 14 agent tools (bash, file I/O, glob, grep, web fetch, and all IPC tools).

**Commit:** `0a9100f` — `feat: add LangChain provider with multi-model support`

**Files created:**
- `container/agent-runner/src/providers/langchain.ts`
- `container/agent-runner/src/providers/tools.ts`

---

### Phase 4: Host-Side Configuration ✅

Added `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` to `config.ts`. Expanded `readSecrets()` in `container-runner.ts` to pass provider-specific env vars. Added `--add-host=host.docker.internal:host-gateway` for Docker on Linux (macOS handles this automatically).

**Commit:** `407e8b3` — `feat: add host-side LLM provider configuration`

**Files modified:**
- `src/config.ts`
- `src/container-runner.ts`

---

### Phase 5: Documentation ✅

Updated `CLAUDE.md` with provider architecture documentation. Updated `README.md` with LLM provider configuration section, feature comparison table, and FAQ entry.

**Commits:**
- `682ebeb` — `docs: update CLAUDE.md with multi-LLM provider documentation`
- `75c8343` — `docs: update README.md with multi-LLM provider support`

---

### Bug Fixes (Post-Migration) ✅

Several issues discovered during Docker build and type-checking:

| Commit | Fix |
|--------|-----|
| `4c1e942` | Make `ClaudeProvider` import dynamic to prevent SDK auth check when using LangChain |
| `563235b` | Set LLM config vars in `process.env` before provider selection |
| `5cdda6b` | Downgrade zod to v3 for LangChain compatibility (temporary) |
| `70519ae` | Upgrade to LangChain 1.x + zod 4, fix `HookCallback` type signatures |

The zod version conflict (`claude-agent-sdk` needs zod 4, old LangChain needed zod 3) was the main blocker for Docker builds. Resolved by upgrading all LangChain packages to the 1.x/2.x line which natively supports zod 4.

## In Progress

### Phase 6: End-to-End Verification 🔄

The Docker container should now build cleanly. These tests need to be run:

- [ ] **Docker build** — `cd container && ./build.sh`
- [ ] **Claude provider** — Verify default behavior is unchanged (no config changes needed)
- [ ] **Gemini** — Set `LLM_PROVIDER=langchain`, `LLM_MODEL=gemini-2.0-flash`, `LLM_API_KEY=<key>` and verify tool use works
- [ ] **LMStudio** — Set `LLM_PROVIDER=langchain`, `LLM_BASE_URL=http://host.docker.internal:1234/v1` and verify local model works

## Future Work

### Session Persistence for LangChain Provider

Claude SDK handles session persistence natively. For the LangChain provider, conversations start fresh each container invocation. Building custom session persistence (saving/loading LangGraph checkpoints) would allow multi-turn conversations across container restarts.

### MCP Server Support for LangChain Provider

The Claude provider connects to MCP servers (custom tool servers). The LangChain provider currently only uses its built-in tools. Adding MCP client support to the LangChain provider would allow it to use the same custom tool ecosystem.

### Streaming Responses for LangChain Provider

The current LangChain provider waits for the full agent response before yielding. Adding streaming would improve perceived latency for long-running agent tasks.

### Container Network Isolation

Containers currently have **unrestricted outbound network access** (documented in `docs/SECURITY.md`). This creates a prompt injection → SSRF attack vector: a malicious webpage fetched via `web_fetch` or `bash` could instruct the agent to scan or access internal network services (routers, NAS, local APIs).

**Mitigation options (pick one):**

| Approach | Effort | Trade-off |
|----------|--------|-----------|
| **iptables in container** — Block RFC 1918 ranges (10.x, 172.16.x, 192.168.x), whitelist only `host.docker.internal` for LLM endpoint | Low | Agent can browse the internet but not the LAN |
| **Docker `--network=none`** — Full network isolation with an explicit HTTP proxy for allowed traffic | Medium | Requires a proxy; breaks web tools unless whitelisted |
| **Remove web tools for untrusted groups** — Strip `WebFetch`/`web_fetch` from non-main group tool lists | Low | Untrusted groups lose web access entirely |
| **DNS filtering** — Block resolution of internal hostnames | Low | Doesn't prevent direct IP access |

The **recommended** approach is iptables rules blocking private IP ranges, with an explicit allow for `host.docker.internal` when `LLM_BASE_URL` points to a local model.

## Known Limitations

| Limitation | Details |
|-----------|---------|
| **Agent Teams** | Not available for non-Claude providers. Claude's agent teams (`Task`, `TeamCreate`, etc.) are proprietary to the Claude Agent SDK. |
| **Session resume** | Not supported for LangChain provider. Conversations start fresh per container invocation. |
| **Tool quality** | Local models with weak function-calling may not use tools reliably. Gemini and GPT-4o work well. |
| **MCP servers** | Only the Claude provider connects to MCP servers. LangChain uses built-in tools only. |
| **Reminders/scheduling** | ~The LangChain provider has `schedule_task` and `list_tasks` tools available, but the system prompt is too generic.~ **Addressed:** System prompt now includes explicit instructions to use `schedule_task` for reminders and `list_tasks` to check them. |
| **Persistent memory** | ~Claude Code natively manages `CLAUDE.md` as persistent memory.~ **Addressed:** Added dedicated `update_memory` tool with **multi-user isolation** (writes to `users/{user}/CLAUDE.md`). System prompt automatically loads the active user's memory. |

## Test Coverage Improvement Plan

Current test coverage is limited to host-side utilities. The following areas need valid test coverage:

### 1. Container Side (Unit Tests)
Create a new test suite in `container/agent-runner/src/` to verify provider logic without running Docker.

- [ ] **Tools (`providers/tools.test.ts`):** 
    - Test `createUpdateMemoryTool`:
        - Verify it writes to `CLAUDE.md` for main group (no active user).
        - Verify it writes to `users/{user}/CLAUDE.md` when `activeUser` is provided.
        - Verify directory creation.
- [ ] **LangChain Provider (`providers/langchain.test.ts`):**
    - Mock `ChatOpenAI` / `ChatGoogleGenerativeAI`.
    - Verify `query` passes `activeUser` to tool creation.
    - Verify system prompt includes user memory when `activeUser` is set.

### 2. Host Side (Integration/Unit)
- [ ] **Container Input Serialization (`container-runner.test.ts`):**
    - Update tests to verify `activeUser` field is correctly serialized into `ContainerInput`.
- [ ] **Message Processing Logic (`index.test.ts`):**
    - Refactor `processGroupMessages` to extract input preparation logic.
    - Test that `activeUser` is correctly identified from the last message of a batch.

### 3. End-to-End (Manual/Automated)
- [ ] **Memory Isolation Test:**
    - Script that simulates two users sending messages.
    - Check that `users/A/CLAUDE.md` and `users/B/CLAUDE.md` are created separately.


## Configuration Reference

```bash
# .env file
LLM_PROVIDER=claude         # "claude" (default) or "langchain"
LLM_MODEL=gemini-2.0-flash  # Model name (provider-specific)
LLM_API_KEY=your-api-key    # API key for the model provider
LLM_BASE_URL=               # Base URL for OpenAI-compatible endpoints
GOOGLE_API_KEY=              # Alternative to LLM_API_KEY for Gemini
```
