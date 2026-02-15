/**
 * Tool Definitions for LangChain Provider
 *
 * Implements the agent tools (bash, file I/O, web, IPC) as LangChain
 * DynamicStructuredTool instances. These replicate the built-in tools
 * that the Claude Agent SDK provides for free.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import {
    sendIpcMessage,
    scheduleIpcTask,
    readCurrentTasks,
    writeTaskAction,
    registerIpcGroup,
} from '../ipc-utils.js';

const BASH_TIMEOUT = 120_000; // 2 minutes
const MAX_FILE_SIZE = 1_000_000; // 1MB
const MAX_OUTPUT_SIZE = 100_000; // 100KB

// ---------------------------------------------------------------------------
// Core agent tools
// ---------------------------------------------------------------------------

export function createBashTool(cwd: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'bash',
        description:
            'Execute a bash command. Use for running scripts, installing packages, file operations, git, etc. Commands run in the container workspace.',
        schema: z.object({
            command: z.string().describe('The bash command to execute'),
            timeout: z
                .number()
                .optional()
                .describe('Timeout in milliseconds (default 120000)'),
        }),
        func: async ({ command, timeout }) => {
            try {
                const result = execSync(command, {
                    cwd,
                    timeout: timeout || BASH_TIMEOUT,
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                    maxBuffer: MAX_OUTPUT_SIZE,
                });
                return result || '(no output)';
            } catch (err: unknown) {
                const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
                const stdout = execErr.stdout || '';
                const stderr = execErr.stderr || '';
                return `Exit code: ${execErr.status || 'unknown'}\nStdout: ${stdout}\nStderr: ${stderr}`;
            }
        },
    });
}

export function createReadFileTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'read_file',
        description:
            'Read the contents of a file. Optionally specify a line range.',
        schema: z.object({
            path: z.string().describe('Absolute or relative path to the file'),
            start_line: z
                .number()
                .optional()
                .describe('Start line (1-indexed, inclusive)'),
            end_line: z
                .number()
                .optional()
                .describe('End line (1-indexed, inclusive)'),
        }),
        func: async ({ path: filePath, start_line, end_line }) => {
            try {
                const absPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.resolve(filePath);

                const stat = fs.statSync(absPath);
                if (stat.size > MAX_FILE_SIZE) {
                    return `File is too large (${stat.size} bytes). Max: ${MAX_FILE_SIZE} bytes. Use start_line/end_line to read a portion.`;
                }

                const content = fs.readFileSync(absPath, 'utf-8');

                if (start_line || end_line) {
                    const lines = content.split('\n');
                    const start = (start_line || 1) - 1;
                    const end = end_line || lines.length;
                    return lines.slice(start, end).join('\n');
                }

                return content;
            } catch (err) {
                return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

export function createWriteFileTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'write_file',
        description:
            'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
        schema: z.object({
            path: z.string().describe('Absolute or relative path to the file'),
            content: z.string().describe('The content to write'),
        }),
        func: async ({ path: filePath, content }) => {
            try {
                const absPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.resolve(filePath);
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                fs.writeFileSync(absPath, content);
                return `File written: ${absPath} (${content.length} bytes)`;
            } catch (err) {
                return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

export function createEditFileTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'edit_file',
        description:
            'Edit a file by replacing a specific string with a new string. The old_string must match exactly.',
        schema: z.object({
            path: z.string().describe('Path to the file'),
            old_string: z.string().describe('The exact string to find and replace'),
            new_string: z.string().describe('The replacement string'),
        }),
        func: async ({ path: filePath, old_string, new_string }) => {
            try {
                const absPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.resolve(filePath);
                const content = fs.readFileSync(absPath, 'utf-8');

                if (!content.includes(old_string)) {
                    return 'Error: old_string not found in file. Make sure it matches exactly (including whitespace).';
                }

                const newContent = content.replace(old_string, new_string);
                fs.writeFileSync(absPath, newContent);
                return 'File edited successfully.';
            } catch (err) {
                return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

export function createGlobTool(cwd: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'glob',
        description:
            'Find files matching a glob pattern. Returns a list of matching file paths.',
        schema: z.object({
            pattern: z
                .string()
                .describe('Glob pattern (e.g., "**/*.ts", "*.md")'),
        }),
        func: async ({ pattern }) => {
            try {
                // Use find command as a cross-platform glob
                const result = execSync(
                    `find . -path './${pattern}' -o -name '${pattern}' 2>/dev/null | head -100`,
                    { cwd, encoding: 'utf-8', timeout: 10000 },
                );
                return result.trim() || 'No files matched.';
            } catch {
                return 'No files matched.';
            }
        },
    });
}

export function createGrepTool(cwd: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'grep',
        description:
            'Search for a pattern in files. Returns matching lines with file names and line numbers.',
        schema: z.object({
            pattern: z.string().describe('The search pattern (regex supported)'),
            path: z
                .string()
                .optional()
                .describe('File or directory to search in (default: current directory)'),
            include: z
                .string()
                .optional()
                .describe('File pattern to include (e.g., "*.ts")'),
        }),
        func: async ({ pattern, path: searchPath, include }) => {
            try {
                let cmd = `grep -rn "${pattern.replace(/"/g, '\\"')}"`;
                if (include) cmd += ` --include="${include}"`;
                cmd += ` ${searchPath || '.'} 2>/dev/null | head -50`;

                const result = execSync(cmd, {
                    cwd,
                    encoding: 'utf-8',
                    timeout: 10000,
                });
                return result.trim() || 'No matches found.';
            } catch {
                return 'No matches found.';
            }
        },
    });
}

export function createWebFetchTool(): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'web_fetch',
        description:
            'Fetch content from a URL. Returns the text content of the page.',
        schema: z.object({
            url: z.string().url().describe('The URL to fetch'),
        }),
        func: async ({ url }) => {
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'NanoClaw-Agent/1.0' },
                    signal: AbortSignal.timeout(15000),
                });
                const text = await response.text();
                // Truncate large responses
                if (text.length > MAX_OUTPUT_SIZE) {
                    return text.slice(0, MAX_OUTPUT_SIZE) + '\n...(truncated)';
                }
                return text;
            } catch (err) {
                return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

// ---------------------------------------------------------------------------
// IPC tools (same functionality as ipc-mcp-stdio.ts MCP tools)
// ---------------------------------------------------------------------------

export function createSendMessageTool(
    chatJid: string,
    groupFolder: string,
): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'send_message',
        description:
            "Send a message to the user or group immediately while you're still running. Use for progress updates or to send multiple messages.",
        schema: z.object({
            text: z.string().describe('The message text to send'),
            sender: z
                .string()
                .optional()
                .describe('Your role/identity name (e.g. "Researcher")'),
        }),
        func: async ({ text, sender }) => {
            sendIpcMessage(chatJid, text, groupFolder, sender);
            return 'Message sent.';
        },
    });
}

export function createScheduleTaskTool(
    chatJid: string,
    groupFolder: string,
    isMain: boolean,
): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'schedule_task',
        description:
            'Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.',
        schema: z.object({
            prompt: z.string().describe('What the agent should do when the task runs'),
            schedule_type: z
                .enum(['cron', 'interval', 'once'])
                .describe('cron=recurring, interval=every N ms, once=one-time'),
            schedule_value: z.string().describe('Cron expression, milliseconds, or ISO timestamp'),
            context_mode: z
                .enum(['group', 'isolated'])
                .default('group')
                .describe('group=with chat history, isolated=fresh session'),
            target_group_jid: z
                .string()
                .optional()
                .describe('(Main only) Target group JID'),
        }),
        func: async ({ prompt, schedule_type, schedule_value, context_mode, target_group_jid }) => {
            const targetJid = isMain && target_group_jid ? target_group_jid : chatJid;
            const filename = scheduleIpcTask({
                prompt,
                schedule_type,
                schedule_value,
                context_mode,
                targetJid,
                createdBy: groupFolder,
            });
            return `Task scheduled (${filename}): ${schedule_type} - ${schedule_value}`;
        },
    });
}

export function createListTasksTool(
    groupFolder: string,
    isMain: boolean,
): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'list_tasks',
        description:
            "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
        schema: z.object({}),
        func: async () => {
            const tasks = readCurrentTasks(groupFolder, isMain);
            if (tasks.length === 0) return 'No scheduled tasks found.';

            return tasks
                .map(
                    (t) =>
                        `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
                )
                .join('\n');
        },
    });
}

export function createUpdateMemoryTool(
    cwd: string,
    isMain: boolean,
    onMemoryUpdate?: (content: string, category?: string) => Promise<string>,
): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'update_memory',
        description: 'Update persistent memory by appending to CLAUDE.md. Use this to remember user preferences, important facts, or project context that should persist across sessions.',
        schema: z.object({
            content: z.string().describe('The content to remember (e.g., "User likes concise responses")'),
            category: z.string().optional().describe('Optional category tag (e.g., "preference", "fact")'),
        }),
        func: async ({ content, category }) => {
            if (onMemoryUpdate) {
                return await onMemoryUpdate(content, category);
            }

            let targetFile = `${cwd}/CLAUDE.md`; // Default to group memory

            // Fallback: write to CLAUDE.md if no callback (legacy)
            // Note: activeUser is not available here anymore, so no isolation in fallback.
            const timestamp = new Date().toISOString().split('T')[0];
            const categoryTag = category ? `[${category.toUpperCase()}] ` : '';
            const entry = `\n- ${categoryTag}${content} (Added: ${timestamp})`;

            try {
                fs.appendFileSync(targetFile, entry);
                return `Memory updated in ${targetFile}`;
            } catch (err) {
                return `Failed to update memory: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

export function createManageTaskTool(
    groupFolder: string,
    isMain: boolean,
): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'manage_task',
        description: 'Pause, resume, or cancel a scheduled task.',
        schema: z.object({
            action: z.enum(['pause', 'resume', 'cancel']).describe('The action to perform'),
            task_id: z.string().describe('The task ID'),
        }),
        func: async ({ action, task_id }) => {
            const ipcAction = `${action}_task` as 'pause_task' | 'resume_task' | 'cancel_task';
            writeTaskAction(ipcAction, task_id, groupFolder, isMain);
            return `Task ${task_id} ${action} requested.`;
        },
    });
}

export function createRegisterGroupTool(isMain: boolean): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: 'register_group',
        description:
            'Register a new group so the agent can respond to messages there. Main group only.',
        schema: z.object({
            jid: z.string().describe('The group JID'),
            name: z.string().describe('Display name for the group'),
            folder: z.string().describe('Folder name for group files'),
            trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
        }),
        func: async (args) => {
            if (!isMain) {
                return 'Only the main group can register new groups.';
            }
            registerIpcGroup(args);
            return `Group "${args.name}" registered. It will start receiving messages immediately.`;
        },
    });
}

// ---------------------------------------------------------------------------
// Build complete tool set
// ---------------------------------------------------------------------------

export function buildAllTools(
    cwd: string,
    chatJid: string,
    groupFolder: string,
    isMain: boolean,
    onMemoryUpdate?: (content: string, category?: string) => Promise<string>,
): DynamicStructuredTool[] {
    const tools: DynamicStructuredTool[] = [
        // Core agent tools
        createBashTool(cwd),
        createReadFileTool(),
        createWriteFileTool(),
        createEditFileTool(),
        createGlobTool(cwd),
        createGrepTool(cwd),
        createWebFetchTool(),

        // IPC tools
        createSendMessageTool(chatJid, groupFolder),
        createScheduleTaskTool(chatJid, groupFolder, isMain),
        createListTasksTool(groupFolder, isMain),
        createManageTaskTool(groupFolder, isMain),
        createUpdateMemoryTool(cwd, isMain, onMemoryUpdate),
    ];

    // Only main group can register new groups
    if (isMain) {
        tools.push(createRegisterGroupTool(isMain));
    }

    return tools;
}
