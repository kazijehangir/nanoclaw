/**
 * Email Channel for NanoClaw
 *
 * Polls Gmail for emails matching a trigger (label, address, or subject prefix),
 * processes them through the agent, and sends email replies.
 *
 * Uses Gmail REST API directly with OAuth credentials from store/gmail-mcp/.
 */

import fs from 'fs';
import path from 'path';

import {
  EMAIL_TRIGGER_MODE,
  EMAIL_TRIGGER_VALUE,
  EMAIL_CONTEXT_MODE,
  GMAIL_CREDS_DIR,
} from './config.js';
import { logger } from './logger.js';

const GMAIL_CREDS_PATH = path.join(GMAIL_CREDS_DIR, 'credentials.json');
const GMAIL_KEYS_PATH = path.join(GMAIL_CREDS_DIR, 'gcp-oauth.keys.json');

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  messageIdHeader: string; // RFC Message-ID for threading replies
}

// ---------------------------------------------------------------------------
// Gmail API helpers
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  if (!fs.existsSync(GMAIL_CREDS_PATH) || !fs.existsSync(GMAIL_KEYS_PATH)) {
    throw new Error('Gmail credentials not found in store/gmail-mcp/');
  }

  const creds = JSON.parse(fs.readFileSync(GMAIL_CREDS_PATH, 'utf-8'));
  const keys = JSON.parse(fs.readFileSync(GMAIL_KEYS_PATH, 'utf-8'));
  const config = keys.installed || keys.web;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(
      `Gmail token refresh failed: ${data.error} - ${data.error_description}`,
    );
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedToken.token;
}

async function gmailApi(
  endpoint: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const token = await getAccessToken();
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gmail API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Email operations
// ---------------------------------------------------------------------------

function buildSearchQuery(): string {
  switch (EMAIL_TRIGGER_MODE) {
    case 'label':
      return `label:${EMAIL_TRIGGER_VALUE} is:unread`;
    case 'address':
      return `to:${EMAIL_TRIGGER_VALUE} is:unread`;
    case 'subject':
      return `subject:${EMAIL_TRIGGER_VALUE} is:unread`;
  }
}

function extractBody(payload: {
  body?: { data?: string };
  parts?: Array<{
    mimeType: string;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
  }>;
}): string {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  return '';
}

export async function checkForNewEmails(): Promise<EmailMessage[]> {
  const query = buildSearchQuery();
  const list = (await gmailApi(
    `messages?q=${encodeURIComponent(query)}&maxResults=10`,
  )) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  if (!list.messages || list.messages.length === 0) return [];

  const emails: EmailMessage[] = [];

  for (const msg of list.messages) {
    try {
      const detail = (await gmailApi(`messages/${msg.id}?format=full`)) as {
        id: string;
        threadId: string;
        snippet: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          body?: { data?: string };
          parts?: Array<{
            mimeType: string;
            body?: { data?: string };
            parts?: Array<{
              mimeType: string;
              body?: { data?: string };
            }>;
          }>;
        };
      };

      const headers = detail.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
          ?.value || '';

      const body = detail.payload
        ? extractBody(detail.payload)
        : detail.snippet;

      emails.push({
        id: msg.id,
        threadId: msg.threadId,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject') || '(no subject)',
        body: body || detail.snippet,
        date: getHeader('Date'),
        messageIdHeader: getHeader('Message-ID'),
      });
    } catch (err) {
      logger.error({ err, messageId: msg.id }, 'Failed to fetch email details');
    }
  }

  return emails;
}

export async function markAsRead(messageId: string): Promise<void> {
  try {
    await gmailApi(`messages/${messageId}/modify`, 'POST', {
      removeLabelIds: ['UNREAD'],
    });
  } catch (err) {
    logger.error({ err, messageId }, 'Failed to mark email as read');
  }
}

export async function sendEmailReply(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  inReplyTo?: string,
): Promise<void> {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  let headers = `To: ${to}\r\nSubject: ${replySubject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
  if (inReplyTo) {
    headers += `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\n`;
  }

  const raw = Buffer.from(`${headers}\r\n${body}`).toString('base64url');

  await gmailApi('messages/send', 'POST', { raw, threadId });
  logger.info({ to, subject: replySubject }, 'Email reply sent');
}

export function getContextKey(email: EmailMessage): string {
  switch (EMAIL_CONTEXT_MODE) {
    case 'thread':
      return `email-thread-${email.threadId}`;
    case 'sender': {
      // Extract email address from "Name <email>" format
      const match = email.from.match(/<([^>]+)>/);
      const addr = match ? match[1] : email.from;
      return `email-sender-${addr.toLowerCase().replace(/[^a-z0-9@.-]/g, '_')}`;
    }
    case 'single':
      return 'email-main';
  }
}

export function isGmailConfigured(): boolean {
  return fs.existsSync(GMAIL_CREDS_PATH) && fs.existsSync(GMAIL_KEYS_PATH);
}
