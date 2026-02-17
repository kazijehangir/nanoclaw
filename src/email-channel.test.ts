import { describe, it, expect, vi } from 'vitest';
import { getContextKey, EmailMessage } from './email-channel.js';

// Mock config module to control EMAIL_CONTEXT_MODE
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    EMAIL_CONTEXT_MODE: 'sender',
  };
});

describe('getContextKey', () => {
  // Helper to create a dummy email message
  const createEmail = (
    from: string,
    threadId: string = 'thread-123',
  ): EmailMessage => ({
    id: 'msg-123',
    threadId,
    from,
    to: 'me@example.com',
    subject: 'Test Subject',
    body: 'Test Body',
    date: '2023-01-01',
    messageIdHeader: 'msg-id-123',
  });

  it('extracts email from simple sender string', () => {
    const email = createEmail('user@example.com');
    // regex: /[^a-z0-9@.-]/g replaced by _
    // user@example.com -> user@example.com
    expect(getContextKey(email)).toBe('email-sender-user@example.com');
  });

  it('extracts email from "Name <email>" format', () => {
    const email = createEmail('John Doe <john.doe@example.com>');
    expect(getContextKey(email)).toBe('email-sender-john.doe@example.com');
  });

  it('handles complex names with special characters in name', () => {
    const email = createEmail('"Doe, John" <john.doe@example.com>');
    expect(getContextKey(email)).toBe('email-sender-john.doe@example.com');
  });

  it('handles email with special allowed characters', () => {
    const email = createEmail('user-name.123@sub.domain.com');
    expect(getContextKey(email)).toBe(
      'email-sender-user-name.123@sub.domain.com',
    );
  });

  it('sanitizes unsafe characters in email address', () => {
    // ! is not allowed in our sanitization regex
    const email = createEmail('bad!char@example.com');
    // bad!char@example.com -> bad_char@example.com
    expect(getContextKey(email)).toBe('email-sender-bad_char@example.com');
  });

  it('handles upper case emails by lowercasing', () => {
    const email = createEmail('User@Example.COM');
    expect(getContextKey(email)).toBe('email-sender-user@example.com');
  });

  it('handles angle brackets without name', () => {
    const email = createEmail('<user@example.com>');
    expect(getContextKey(email)).toBe('email-sender-user@example.com');
  });

  it('handles multiple angle brackets (takes first match)', () => {
    // Regex /<([^>]+)>/ matches first <...> pair
    const email = createEmail('Name <user@example.com> <other@example.com>');
    expect(getContextKey(email)).toBe('email-sender-user@example.com');
  });

  it('handles malformed input with missing closing bracket', () => {
    // Regex /<([^>]+)>/ expects closing >
    // If missing, match is null. Falls back to full string.
    const email = createEmail('<user@example.com');
    // <user@example.com -> _user@example.com (< replaced by _)
    expect(getContextKey(email)).toBe('email-sender-_user@example.com');
  });

  it('handles malformed input with missing opening bracket', () => {
    const email = createEmail('user@example.com>');
    // Match is null.
    // user@example.com> -> user@example.com_ (> replaced by _)
    expect(getContextKey(email)).toBe('email-sender-user@example.com_');
  });

  it('handles empty sender', () => {
    const email = createEmail('');
    expect(getContextKey(email)).toBe('email-sender-');
  });

  it('handles sender with only special characters', () => {
    const email = createEmail('!@#$%^&*()');
    // !@#$%^&*() -> _@_______
    // allowed: @ . - a-z 0-9
    // ! -> _
    // @ -> @
    // # -> _
    // $ -> _
    // % -> _
    // ^ -> _
    // & -> _
    // * -> _
    // ( -> _
    // ) -> _
    expect(getContextKey(email)).toBe('email-sender-_@________');
  });
});
