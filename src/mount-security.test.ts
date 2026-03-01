import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock config before importing mount-security
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/tmp/test-mount-allowlist.json',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    },
  };
});

import {
  loadMountAllowlist,
  _resetMountAllowlistCache,
} from './mount-security.js';

describe('mount-security', () => {
  beforeEach(() => {
    _resetMountAllowlistCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetMountAllowlistCache();
  });

  describe('loadMountAllowlist', () => {
    it('returns null when allowlist file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = loadMountAllowlist();

      expect(result).toBeNull();
    });

    it('returns parsed allowlist when file is valid', () => {
      mockExistsSync.mockReturnValue(true);
      const validConfig = {
        allowedRoots: [
          {
            path: '~/projects',
            allowReadWrite: true,
            description: 'Development projects',
          },
        ],
        blockedPatterns: ['.git'],
        nonMainReadOnly: true,
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(validConfig));

      const result = loadMountAllowlist();

      expect(result).toEqual({
        ...validConfig,
        blockedPatterns: expect.arrayContaining(['.git', '.ssh', '.env']), // Should include defaults
      });
    });

    it('returns null when allowlist file contains invalid JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not-json');

      const result = loadMountAllowlist();

      expect(result).toBeNull();
    });

    it('returns null when allowedRoots is missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          blockedPatterns: [],
          nonMainReadOnly: true,
        }),
      );

      const result = loadMountAllowlist();

      expect(result).toBeNull();
    });

    it('returns null when blockedPatterns is missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [],
          nonMainReadOnly: true,
        }),
      );

      const result = loadMountAllowlist();

      expect(result).toBeNull();
    });

    it('returns null when nonMainReadOnly is not a boolean', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: [],
          nonMainReadOnly: 'yes',
        }),
      );

      const result = loadMountAllowlist();

      expect(result).toBeNull();
    });

    it('caches the result across calls', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: [],
          nonMainReadOnly: true,
        }),
      );

      loadMountAllowlist();
      loadMountAllowlist();

      // The file should only be read once
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });
  });
});
