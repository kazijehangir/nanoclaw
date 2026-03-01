/**
 * Shared IPC Utilities for NanoClaw
 *
 * Extracted from ipc-mcp-stdio.ts so that both the MCP server (used by Claude
 * provider) and the LangChain tool definitions can write IPC files without
 * duplicating logic.
 */

import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

/**
 * Write a JSON file atomically to an IPC directory.
 * Returns the generated filename.
 */
export function writeIpcFile(dir: string, data: object): string {
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-${randomUUID()}.json`;
    const filepath = path.join(dir, filename);

    // Atomic write: temp file then rename
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);

    return filename;
}

/**
 * Send a message to the user or group via IPC.
 */
export function sendIpcMessage(
    chatJid: string,
    text: string,
    groupFolder: string,
    sender?: string,
): string {
    const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid,
        text,
        sender: sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
    };

    return writeIpcFile(MESSAGES_DIR, data);
}

/**
 * Schedule a task via IPC.
 */
export function scheduleIpcTask(args: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode: 'group' | 'isolated';
    targetJid: string;
    createdBy: string;
}): string {
    const data = {
        type: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode,
        targetJid: args.targetJid,
        createdBy: args.createdBy,
        timestamp: new Date().toISOString(),
    };

    return writeIpcFile(TASKS_DIR, data);
}

/**
 * Write a task action (pause, resume, cancel) via IPC.
 */
export function writeTaskAction(
    actionType: 'pause_task' | 'resume_task' | 'cancel_task',
    taskId: string,
    groupFolder: string,
    isMain: boolean,
): string {
    const data = {
        type: actionType,
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
    };

    return writeIpcFile(TASKS_DIR, data);
}

/**
 * Register a new group via IPC (main group only).
 */
export function registerIpcGroup(args: {
    jid: string;
    name: string;
    folder: string;
    trigger: string;
}): string {
    const data = {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        timestamp: new Date().toISOString(),
    };

    return writeIpcFile(TASKS_DIR, data);
}

/**
 * Read the current tasks snapshot from the IPC directory.
 */
export function readCurrentTasks(
    groupFolder: string,
    isMain: boolean,
): Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string;
}> {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    if (!fs.existsSync(tasksFile)) {
        return [];
    }

    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    return isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
}

// Re-export directory constants for use by consumers
export { IPC_DIR, MESSAGES_DIR, TASKS_DIR };
