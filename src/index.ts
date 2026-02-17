import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  EMAIL_ENABLED,
  EMAIL_POLL_INTERVAL,
  EMAIL_TRIGGER_MODE,
  EMAIL_TRIGGER_VALUE,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { DiscordChannel } from './channels/discord.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Channel } from './types.js';
import { logger } from './logger.js';
import { isGmailAllowed } from './gmail-security.js';
import {
  getChatName,
  isEmailProcessed,
  markEmailProcessed,
  markEmailResponded,
  updateChatName,
} from './db.js';
import {
  checkForNewEmails,
  getContextKey,
  isGmailConfigured,
  markAsRead,
  sendEmailReply,
} from './email-channel.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function getChannelForJid(jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Check if any message is from an admin user (for sender-based security)
  const adminUsers = group.adminUsers || [];
  let hasAdminMessage = false;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Check if any message is from an admin user
  if (adminUsers.length > 0) {
    hasAdminMessage = missedMessages.some((m) => adminUsers.includes(m.sender));
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  const channel = getChannelForJid(chatJid);
  if (!channel) {
    logger.error({ chatJid }, 'No channel found for JID');
    return false;
  }

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Check if Gmail access is allowed for this group + these senders
  const senders = [...new Set(missedMessages.map((m) => m.sender))];
  const gmailEnabled = isGmailAllowed(group.folder, senders);

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          const prefix =
            channel.prefixAssistantName !== false ? `${ASSISTANT_NAME}: ` : '';
          await channel.sendMessage(chatJid, `${prefix}${text}`);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    hasAdminMessage,
    gmailEnabled,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  hasAdminMessage?: boolean,
  gmailEnabled?: boolean,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER || hasAdminMessage === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        gmailEnabled: gmailEnabled === true,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (await queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            getChannelForJid(chatJid)?.setTyping?.(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// ---------------------------------------------------------------------------
// Email channel loop
// ---------------------------------------------------------------------------

async function processEmail(
  email: import('./email-channel.js').EmailMessage,
): Promise<void> {
  const contextKey = getContextKey(email);
  const folderName = contextKey.replace(/[^a-z0-9-_]/g, '_');
  const groupFolder = `email/${folderName}`;

  // Ensure group folder exists
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Write a CLAUDE.md for email context if it doesn't exist
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      '# Email Channel\n\nYou are responding to emails. Your response will be sent as an email reply.\nBe professional and clear. Keep responses concise but complete.\n',
    );
  }

  const emailGroup: RegisteredGroup = {
    name: `Email: ${contextKey}`,
    folder: groupFolder,
    trigger: '',
    added_at: new Date().toISOString(),
  };

  const prompt = `<email>\n<from>${email.from}</from>\n<subject>${email.subject}</subject>\n<date>${email.date}</date>\n<body>\n${email.body}\n</body>\n</email>\n\nRespond to this email. Your response will be sent as an email reply. Do not include subject lines or email headers — just write the body of your reply.`;

  let replyText = '';

  const status = await runAgent(
    emailGroup,
    prompt,
    `email:${email.from}`,
    async (output) => {
      if (output.result) {
        const raw =
          typeof output.result === 'string'
            ? output.result
            : JSON.stringify(output.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) replyText = text;
      }
    },
  );

  if (status === 'success' && replyText) {
    await sendEmailReply(
      email.from,
      email.subject,
      replyText,
      email.threadId,
      email.messageIdHeader,
    );
    markEmailResponded(email.id);
  }
}

async function startEmailLoop(): Promise<void> {
  if (!EMAIL_ENABLED || !isGmailConfigured()) {
    if (EMAIL_ENABLED) {
      logger.warn('Email channel enabled but Gmail credentials not found');
    }
    return;
  }

  logger.info(
    { triggerMode: EMAIL_TRIGGER_MODE, triggerValue: EMAIL_TRIGGER_VALUE },
    'Email channel running',
  );

  while (true) {
    try {
      const emails = await checkForNewEmails();

      for (const email of emails) {
        if (isEmailProcessed(email.id)) continue;

        logger.info(
          { from: email.from, subject: email.subject },
          'Processing email',
        );
        markEmailProcessed(email.id, email.threadId, email.from, email.subject);
        await markAsRead(email.id);

        try {
          await processEmail(email);
        } catch (err) {
          logger.error({ err, emailId: email.id }, 'Error processing email');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in email loop');
    }

    await new Promise((resolve) => setTimeout(resolve, EMAIL_POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                     ║',
    );
    console.error(
      '║  macOS: Start Docker Desktop                                   ║',
    );
    console.error(
      '║  Linux: sudo systemctl start docker                            ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Install from: https://docker.com/products/docker-desktop      ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('docker ps --format json --filter name=nanoclaw-', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans: string[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      try {
        const c = JSON.parse(line);
        if (c.Names && c.Names.startsWith('nanoclaw-')) {
          orphans.push(c.Names);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const channel of channels) {
      await channel.disconnect();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Initialize channels based on environment variables
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const hasWhatsAppAuth = fs.existsSync(path.join(STORE_DIR, 'auth'));

  if (discordToken) {
    logger.info('Initializing Discord channel');
    const discord = new DiscordChannel({
      token: discordToken,
      onMessage: (chatJid, msg) => {
        storeMessage(msg);
        // Auto-register Discord DMs so all users get responses
        if (chatJid.endsWith('@discord.dm') && !registeredGroups[chatJid]) {
          const folderName = `discord-dm-${chatJid.split('@')[0]}`;
          registerGroup(chatJid, {
            name: `Discord DM: ${msg.sender_name}`,
            folder: folderName,
            trigger: ASSISTANT_NAME,
            added_at: new Date().toISOString(),
            requiresTrigger: false,
            // No adminUsers — non-admin access by default
          });
          logger.info(
            { chatJid, user: msg.sender_name },
            'Auto-registered Discord DM',
          );
        }
      },
      onChatMetadata: (chatJid, timestamp, name) => {
        storeChatMetadata(chatJid, timestamp);
        if (name) updateChatName(chatJid, name);
      },
      registeredGroups: () => registeredGroups,
    });
    channels.push(discord);
    await discord.connect();
  }

  if (hasWhatsAppAuth) {
    logger.info('Initializing WhatsApp channel');
    const whatsapp = new WhatsAppChannel({
      onMessage: (chatJid, msg) => {
        storeMessage(msg);
        // Auto-register WhatsApp groups on first message
        if (chatJid.endsWith('@g.us') && !registeredGroups[chatJid]) {
          const chatName = getChatName(chatJid);
          const folderName = chatName
            ? chatName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
            : `wa-group-${chatJid.split('@')[0]}`;
          registerGroup(chatJid, {
            name: chatName || chatJid,
            folder: folderName,
            trigger: ASSISTANT_NAME,
            added_at: new Date().toISOString(),
            requiresTrigger: true,
          });
          logger.info(
            { chatJid, name: chatName },
            'Auto-registered WhatsApp group',
          );
        }
      },
      onChatMetadata: (chatJid, timestamp) =>
        storeChatMetadata(chatJid, timestamp),
      registeredGroups: () => registeredGroups,
    });
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (channels.length === 0) {
    logger.error(
      'No channels configured. Set DISCORD_BOT_TOKEN or run WhatsApp auth.',
    );
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = getChannelForJid(jid);
      if (!channel) {
        logger.error({ jid }, 'No channel found for JID in scheduler');
        return;
      }
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = getChannelForJid(jid);
      if (!channel) {
        logger.error({ jid }, 'No channel found for JID in IPC');
        return Promise.resolve();
      }
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => {
      // Only WhatsApp has syncGroupMetadata
      const whatsapp = channels.find((c) => c.name === 'whatsapp') as
        | WhatsAppChannel
        | undefined;
      if (whatsapp?.syncGroupMetadata) {
        return whatsapp.syncGroupMetadata(force);
      }
      return Promise.resolve();
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
  startEmailLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
