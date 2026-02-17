import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdditionalMount } from './types.js';

// Mocks
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    realpathSync: (...args: any[]) => mockRealpathSync(...args),
  },
}));

describe('validateAdditionalMounts', () => {
  let validateAdditionalMounts: any;

  // Constants
  const DEFAULT_ALLOWLIST = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/readonly',
        allowReadWrite: false,
        description: 'Read-only root',
      },
    ],
    blockedPatterns: ['secret', '.env'],
    nonMainReadOnly: true,
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(DEFAULT_ALLOWLIST));

    // robust mock implementation for realpath
    mockRealpathSync.mockImplementation((p: string) => {
      // Handle roots
      if (p === '/Users/user/projects') return '/Users/user/projects';
      if (p === '/Users/user/readonly') return '/Users/user/readonly';

      // Handle specific files/dirs in tests
      if (p.startsWith('/Users/user/projects/')) return p;
      if (p.startsWith('/Users/user/readonly/')) return p;

      // Fallback
      return p;
    });

    process.env.HOME = '/Users/user';

    const module = await import('./mount-security.js');
    validateAdditionalMounts = module.validateAdditionalMounts;
  });

  it('should allow valid mounts under allowed roots', () => {
    const mounts: AdditionalMount[] = [
      { hostPath: '~/projects/my-app', readonly: false },
    ];
    // No need to override mockRealpathSync, the default implementation handles it

    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      hostPath: '/Users/user/projects/my-app',
      containerPath: '/workspace/extra/my-app',
      readonly: false,
    });
  });

  it('should block mounts matching blocked patterns', () => {
    const mounts: AdditionalMount[] = [
      { hostPath: '~/projects/my-app/.env', readonly: false },
    ];

    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(0);
  });

  it('should block mounts for non-existent paths', () => {
    const mounts: AdditionalMount[] = [
      { hostPath: '~/projects/non-existent', readonly: false },
    ];

    // Override mock for this test
    mockRealpathSync.mockImplementation((p: string) => {
      if (p.includes('non-existent')) throw new Error('ENOENT');
      // Keep valid roots working
      if (p.startsWith('/Users/user/projects')) return p;
      return p;
    });

    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(0);
  });

  it('should block invalid container paths', () => {
    const mounts: AdditionalMount[] = [
      {
        hostPath: '~/projects/app',
        containerPath: '../escape',
        readonly: false,
      },
    ];

    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(0);
  });

  it('should force read-only for non-main groups if configured', () => {
    const mounts: AdditionalMount[] = [
      { hostPath: '~/projects/my-app', readonly: false },
    ];

    // Passing isMain=false
    const result = validateAdditionalMounts(mounts, 'secondary-group', false);

    expect(result).toHaveLength(1);
    expect(result[0].readonly).toBe(true);
  });

  it('should force read-only if root does not allow write', () => {
    const mounts: AdditionalMount[] = [
      { hostPath: '~/readonly/docs', readonly: false },
    ];

    // Main group requesting write, but root disallows it
    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(1);
    expect(result[0].readonly).toBe(true);
  });

  it('should fail if allowlist file is missing', () => {
    // Simulate allowlist missing
    mockExistsSync.mockImplementation((path: string) => {
      if (path.endsWith('mount-allowlist.json')) return false;
      return true;
    });

    const mounts: AdditionalMount[] = [
      { hostPath: '~/projects/my-app', readonly: false },
    ];

    const result = validateAdditionalMounts(mounts, 'main', true);

    expect(result).toHaveLength(0);
  });
});
