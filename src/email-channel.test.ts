import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isGmailConfigured } from './email-channel';
import { GMAIL_CREDS_DIR } from './config';

vi.mock('fs');
// Mock logger to avoid console noise if imported
vi.mock('./logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('isGmailConfigured', () => {
  const credentialsPath = path.join(GMAIL_CREDS_DIR, 'credentials.json');
  const keysPath = path.join(GMAIL_CREDS_DIR, 'gcp-oauth.keys.json');

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return true if both credentials and keys exist', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === credentialsPath || filePath === keysPath;
    });
    expect(isGmailConfigured()).toBe(true);
  });

  it('should return false if credentials are missing', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === keysPath;
    });
    expect(isGmailConfigured()).toBe(false);
  });

  it('should return false if keys are missing', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === credentialsPath;
    });
    expect(isGmailConfigured()).toBe(false);
  });

  it('should return false if both are missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(isGmailConfigured()).toBe(false);
  });
});
