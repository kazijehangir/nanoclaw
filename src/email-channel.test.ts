import { describe, it, expect, vi, beforeEach } from 'vitest';

// We import the type, but the module under test will be imported dynamically
import type { EmailMessage } from './email-channel.js';

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'msg-123',
    threadId: 'thread-456',
    from: 'sender@example.com',
    to: 'me@example.com',
    subject: 'Test Subject',
    body: 'Test Body',
    date: '2023-01-01T00:00:00.000Z',
    messageIdHeader: '<msg-123@example.com>',
    ...overrides,
  };
}

describe('getContextKey', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function getContextKeyWithMode(mode: 'thread' | 'sender' | 'single') {
    vi.doMock('./config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./config.js')>();
      return { ...actual, EMAIL_CONTEXT_MODE: mode };
    });
    const { getContextKey } = await import('./email-channel.js');
    return getContextKey;
  }

  it('returns thread context key in thread mode', async () => {
    const getContextKey = await getContextKeyWithMode('thread');
    const email = makeEmail({ threadId: '12345' });
    expect(getContextKey(email)).toBe('email-thread-12345');
  });

  it('returns main context key in single mode', async () => {
    const getContextKey = await getContextKeyWithMode('single');
    const email = makeEmail();
    expect(getContextKey(email)).toBe('email-main');
  });

  describe('sender mode', () => {
    it('extracts simple email address', async () => {
      const getContextKey = await getContextKeyWithMode('sender');
      const email = makeEmail({ from: 'alice@example.com' });
      expect(getContextKey(email)).toBe('email-sender-alice@example.com');
    });

    it('extracts email from "Name <email>" format', async () => {
      const getContextKey = await getContextKeyWithMode('sender');
      const email = makeEmail({ from: 'Alice Smith <alice@example.com>' });
      expect(getContextKey(email)).toBe('email-sender-alice@example.com');
    });

    it('sanitizes special characters in email', async () => {
      const getContextKey = await getContextKeyWithMode('sender');
      // + is not allowed in regex [^a-z0-9@.-] -> replaced by _
      const email = makeEmail({ from: 'bob+tag@example.com' });
      expect(getContextKey(email)).toBe('email-sender-bob_tag@example.com');
    });

    it('lowercases the email', async () => {
      const getContextKey = await getContextKeyWithMode('sender');
      const email = makeEmail({ from: 'Carol@Example.COM' });
      expect(getContextKey(email)).toBe('email-sender-carol@example.com');
    });

    it('handles email where sanitization produces multiple underscores', async () => {
      const getContextKey = await getContextKeyWithMode('sender');
      // e.g. "a#b$c@d.e" -> "a_b_c@d.e"
      const email = makeEmail({ from: 'a#b$c@d.e' });
      expect(getContextKey(email)).toBe('email-sender-a_b_c@d.e');
    });
  });
});
