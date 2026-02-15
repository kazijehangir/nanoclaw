import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// LLM Provider configuration
// Set LLM_PROVIDER=langchain to use non-Claude models (Gemini, LMStudio, etc.)
export const LLM_PROVIDER = process.env.LLM_PROVIDER || 'claude';
export const LLM_MODEL = process.env.LLM_MODEL || '';
export const LLM_BASE_URL = process.env.LLM_BASE_URL || '';

// Email channel configuration
export const EMAIL_ENABLED = process.env.EMAIL_ENABLED === '1' || process.env.EMAIL_ENABLED === 'true';
export const EMAIL_TRIGGER_MODE = (process.env.EMAIL_TRIGGER_MODE || 'label') as 'label' | 'address' | 'subject';
export const EMAIL_TRIGGER_VALUE = process.env.EMAIL_TRIGGER_VALUE || 'Chotay';
export const EMAIL_CONTEXT_MODE = (process.env.EMAIL_CONTEXT_MODE || 'sender') as 'thread' | 'sender' | 'single';
export const EMAIL_POLL_INTERVAL = parseInt(process.env.EMAIL_POLL_INTERVAL || '60000', 10);
export const GMAIL_CREDS_DIR = path.join(HOME_DIR, '.gmail-mcp');
