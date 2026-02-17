import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock fs module
// We mock the default export for 'fs'
const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
};

vi.mock('fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
  realpathSync: mockFs.realpathSync,
}));

// Mock pino logger
vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('loadMountAllowlist', () => {
  let mountSecurity: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // We need to re-import the module under test for every test to reset module-level variables
    // (cachedAllowlist and allowlistLoadError)
    mountSecurity = await import('./mount-security.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return null if allowlist file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = mountSecurity.loadMountAllowlist();

    expect(result).toBeNull();
    expect(mockFs.existsSync).toHaveBeenCalledWith(
      expect.stringContaining('mount-allowlist.json'),
    );
  });

  it('should return null and handle error if file content is invalid JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('invalid json content');

    const result = mountSecurity.loadMountAllowlist();

    expect(result).toBeNull();
    expect(mockFs.readFileSync).toHaveBeenCalled();
  });

  it('should return null if JSON structure is invalid (missing allowedRoots)', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        blockedPatterns: [],
        nonMainReadOnly: true,
        // Missing allowedRoots
      }),
    );

    const result = mountSecurity.loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('should return null if JSON structure is invalid (blockedPatterns not array)', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-an-array',
        nonMainReadOnly: true,
      }),
    );

    const result = mountSecurity.loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('should return null if JSON structure is invalid (nonMainReadOnly not boolean)', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'not-a-boolean',
      }),
    );

    const result = mountSecurity.loadMountAllowlist();

    expect(result).toBeNull();
  });

  it('should load valid allowlist and merge blocked patterns', () => {
    const validConfig = {
      allowedRoots: [{ path: '/tmp/test', allowReadWrite: true }],
      blockedPatterns: ['custom-blocked'],
      nonMainReadOnly: true,
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

    const result = mountSecurity.loadMountAllowlist();

    expect(result).not.toBeNull();
    expect(result.allowedRoots).toHaveLength(1);
    expect(result.allowedRoots[0].path).toBe('/tmp/test');
    expect(result.nonMainReadOnly).toBe(true);

    // Check merging of blocked patterns
    expect(result.blockedPatterns).toContain('custom-blocked');
    expect(result.blockedPatterns).toContain('.ssh'); // From DEFAULT_BLOCKED_PATTERNS
    expect(result.blockedPatterns).toContain('.env'); // From DEFAULT_BLOCKED_PATTERNS
  });

  it('should cache the allowlist after successful load', () => {
    const validConfig = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

    // First call
    const result1 = mountSecurity.loadMountAllowlist();
    expect(result1).not.toBeNull();

    // Reset mocks to verify no further calls
    mockFs.existsSync.mockClear();
    mockFs.readFileSync.mockClear();

    // Second call
    const result2 = mountSecurity.loadMountAllowlist();

    // Should return same object and not hit filesystem
    expect(result2).toBe(result1);
    expect(mockFs.existsSync).not.toHaveBeenCalled();
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it('should cache the error state (return null) without retrying if first attempt failed', () => {
    // First attempt fails (file not found)
    mockFs.existsSync.mockReturnValue(false);

    const result1 = mountSecurity.loadMountAllowlist();
    expect(result1).toBeNull();

    // Reset mocks
    mockFs.existsSync.mockClear();

    // Even if file appears now (mock change), it shouldn't check again because error is cached
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );

    const result2 = mountSecurity.loadMountAllowlist();
    expect(result2).toBeNull();

    // Should not have checked file system again
    expect(mockFs.existsSync).not.toHaveBeenCalled();
  });
});
