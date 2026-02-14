/**
 * Claude Provider for NanoClaw
 *
 * Wraps the Claude Agent SDK's query() function, mapping its messages to the
 * generic AgentMessage format. This preserves the exact existing behavior
 * including hooks, MCP server config, allowed tools, and agent teams support.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, AgentInput, AgentMessage, UserTurn } from './types.js';

// ---------------------------------------------------------------------------
// Session archive helpers (moved from index.ts)
// ---------------------------------------------------------------------------

interface SessionEntry {
    sessionId: string;
    fullPath: string;
    summary: string;
    firstPrompt: string;
}

interface SessionsIndex {
    entries: SessionEntry[];
}

interface ParsedMessage {
    role: 'user' | 'assistant';
    content: string;
}

function log(message: string): void {
    console.error(`[claude-provider] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');

    if (!fs.existsSync(indexPath)) {
        log(`Sessions index not found at ${indexPath}`);
        return null;
    }

    try {
        const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const entry = index.entries.find(e => e.sessionId === sessionId);
        if (entry?.summary) {
            return entry.summary;
        }
    } catch (err) {
        log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;
}

function sanitizeFilename(summary: string): string {
    return summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
}

function generateFallbackName(): string {
    const time = new Date();
    return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function parseTranscript(content: string): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
                const text = typeof entry.message.content === 'string'
                    ? entry.message.content
                    : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
                if (text) messages.push({ role: 'user', content: text });
            } else if (entry.type === 'assistant' && entry.message?.content) {
                const textParts = entry.message.content
                    .filter((c: { type: string }) => c.type === 'text')
                    .map((c: { text: string }) => c.text);
                const text = textParts.join('');
                if (text) messages.push({ role: 'assistant', content: text });
            }
        } catch {
        }
    }

    return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
    const now = new Date();
    const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });

    const lines: string[] = [];
    lines.push(`# ${title || 'Conversation'}`);
    lines.push('');
    lines.push(`Archived: ${formatDateTime(now)}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
        const sender = msg.role === 'user' ? 'User' : 'Andy';
        const content = msg.content.length > 2000
            ? msg.content.slice(0, 2000) + '...'
            : msg.content;
        lines.push(`**${sender}**: ${content}`);
        lines.push('');
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// Secrets to strip from Bash tool subprocess environments.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createPreCompactHook(): HookCallback {
    return async (input, _toolUseId, _context) => {
        const preCompact = input as PreCompactHookInput;
        const transcriptPath = preCompact.transcript_path;
        const sessionId = preCompact.session_id;

        if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            log('No transcript found for archiving');
            return {};
        }

        try {
            const content = fs.readFileSync(transcriptPath, 'utf-8');
            const messages = parseTranscript(content);

            if (messages.length === 0) {
                log('No messages to archive');
                return {};
            }

            const summary = getSessionSummary(sessionId, transcriptPath);
            const name = summary ? sanitizeFilename(summary) : generateFallbackName();

            const conversationsDir = '/workspace/group/conversations';
            fs.mkdirSync(conversationsDir, { recursive: true });

            const date = new Date().toISOString().split('T')[0];
            const filename = `${date}-${name}.md`;
            const filePath = path.join(conversationsDir, filename);

            const markdown = formatTranscriptMarkdown(messages, summary);
            fs.writeFileSync(filePath, markdown);

            log(`Archived conversation to ${filePath}`);
        } catch (err) {
            log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
        }

        return {};
    };
}

function createSanitizeBashHook(): HookCallback {
    return async (input, _toolUseId, _context) => {
        const preInput = input as PreToolUseHookInput;
        const command = (preInput.tool_input as { command?: string })?.command;
        if (!command) return {};

        const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
        return {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: {
                    ...(preInput.tool_input as Record<string, unknown>),
                    command: unsetPrefix + command,
                },
            },
        };
    };
}

// ---------------------------------------------------------------------------
// ClaudeProvider
// ---------------------------------------------------------------------------

export class ClaudeProvider implements LLMProvider {
    readonly name = 'claude';
    readonly supportsSessionResume = true;
    readonly supportsAgentTeams = true;

    private mcpServerPath: string;

    constructor(mcpServerPath: string) {
        this.mcpServerPath = mcpServerPath;
    }

    async *query(input: AgentInput): AsyncIterable<AgentMessage> {
        // Load global CLAUDE.md as additional system context
        const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
        let globalClaudeMd: string | undefined;
        if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
            globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
        }

        // Discover additional directories mounted at /workspace/extra/*
        const extraDirs: string[] = [];
        const extraBase = '/workspace/extra';
        if (fs.existsSync(extraBase)) {
            for (const entry of fs.readdirSync(extraBase)) {
                const fullPath = path.join(extraBase, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    extraDirs.push(fullPath);
                }
            }
        }
        if (extraDirs.length > 0) {
            log(`Additional directories: ${extraDirs.join(', ')}`);
        }

        // Build system prompt
        let systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string } | undefined;
        const appendParts: string[] = [];
        if (globalClaudeMd) appendParts.push(globalClaudeMd);
        if (input.systemPrompt) appendParts.push(input.systemPrompt);
        if (appendParts.length > 0) {
            systemPrompt = {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: appendParts.join('\n\n'),
            };
        }

        for await (const message of query({
            prompt: input.prompt as AsyncIterable<UserTurn>,
            options: {
                cwd: input.cwd,
                additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
                resume: input.sessionId,
                resumeSessionAt: input.resumeAt,
                systemPrompt,
                allowedTools: [
                    'Bash',
                    'Read', 'Write', 'Edit', 'Glob', 'Grep',
                    'WebSearch', 'WebFetch',
                    'Task', 'TaskOutput', 'TaskStop',
                    'TeamCreate', 'TeamDelete', 'SendMessage',
                    'TodoWrite', 'ToolSearch', 'Skill',
                    'NotebookEdit',
                    'mcp__nanoclaw__*'
                ],
                env: input.env,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                settingSources: ['project', 'user'],
                mcpServers: {
                    nanoclaw: {
                        command: 'node',
                        args: [this.mcpServerPath],
                        env: {
                            NANOCLAW_CHAT_JID: input.chatJid,
                            NANOCLAW_GROUP_FOLDER: input.groupFolder,
                            NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
                        },
                    },
                },
                hooks: {
                    PreCompact: [{ hooks: [createPreCompactHook()] }],
                    PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
                },
            }
        })) {
            // Map Claude SDK messages to AgentMessage
            if (message.type === 'system' && message.subtype === 'init') {
                yield {
                    type: 'init',
                    sessionId: message.session_id,
                } as AgentMessage;
            } else if (message.type === 'assistant' && 'uuid' in message) {
                yield {
                    type: 'assistant',
                    uuid: (message as { uuid: string }).uuid,
                } as AgentMessage;
            } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
                const tn = message as { task_id: string; status: string; summary: string };
                yield {
                    type: 'system',
                    subtype: 'task_notification',
                    task_id: tn.task_id,
                    status: tn.status,
                    summary: tn.summary,
                } as AgentMessage;
            } else if (message.type === 'result') {
                const textResult = 'result' in message ? (message as { result?: string }).result : null;
                yield {
                    type: 'result',
                    result: textResult || null,
                    subtype: message.subtype,
                } as AgentMessage;
            }
            // Other message types are dropped (tool_use, tool_result, etc.)
        }
    }
}
