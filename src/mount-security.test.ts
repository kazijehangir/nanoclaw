import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock config
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
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      realpathSync: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    realpathSync: vi.fn(),
  };
});

import fs from 'fs';
import { validateMount } from './mount-security.js';

describe('validateMount', () => {
  const mockAllowlist = {
    allowedRoots: [
      {
        path: '/tmp/allowed',
        allowReadWrite: true,
        description: 'Allowed root',
      },
    ],
    blockedPatterns: ['blocked'],
    nonMainReadOnly: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Setup default mock behavior for fs
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockAllowlist));
    // Mock realpathSync to return the input path by default, simulating existence
    (fs.realpathSync as any).mockImplementation((p: string) => p);
  });

  it('should reject container path with traversal ".." (dot dot)', () => {
    const result = validateMount(
      {
        hostPath: '/tmp/allowed/file.txt',
        containerPath: '../traversal',
        readonly: true,
      },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
    expect(result.reason).toContain('..');
  });

  it('should reject absolute container path', () => {
    const result = validateMount(
      {
        hostPath: '/tmp/allowed/file.txt',
        containerPath: '/absolute/path',
        readonly: true,
      },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
    expect(result.reason).toContain('must be relative');
  });

  it('should reject whitespace-only container path', () => {
    const result = validateMount(
      {
        hostPath: '/tmp/allowed/file.txt',
        containerPath: '   ',
        readonly: true,
      },
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
    expect(result.reason).toContain('non-empty');
  });

  it('should fall back to basename when container path is empty', () => {
    // Ensure mocks allow this
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockAllowlist));
    (fs.realpathSync as any).mockReturnValue('/tmp/allowed/file.txt');

    const result = validateMount(
      {
        hostPath: '/tmp/allowed/file.txt',
        containerPath: '',
        readonly: true,
      },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('file.txt');
  });

  it('should allow valid container path under allowed root', () => {
    // Ensure fs mocks are set for success path
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockAllowlist));
    (fs.realpathSync as any).mockReturnValue('/tmp/allowed/file.txt');

    const result = validateMount(
      {
        hostPath: '/tmp/allowed/file.txt',
        containerPath: 'valid-file.txt',
        readonly: true,
      },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('valid-file.txt');
  });
});
