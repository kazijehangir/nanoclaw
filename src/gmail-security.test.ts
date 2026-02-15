import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock config before importing gmail-security
vi.mock('./config.js', () => ({
    GMAIL_ALLOWLIST_PATH: '/tmp/test-gmail-allowlist.json',
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

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        default: {
            ...actual,
            existsSync: (...args: unknown[]) => mockExistsSync(...args),
            readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        },
    };
});

import {
    isGmailAllowed,
    loadGmailAllowlist,
    _resetGmailAllowlistCache,
} from './gmail-security.js';

describe('gmail-security', () => {
    beforeEach(() => {
        _resetGmailAllowlistCache();
        vi.clearAllMocks();
    });

    afterEach(() => {
        _resetGmailAllowlistCache();
    });

    describe('loadGmailAllowlist', () => {
        it('returns null when allowlist file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            const result = loadGmailAllowlist();

            expect(result).toBeNull();
        });

        it('returns parsed allowlist when file is valid', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            const result = loadGmailAllowlist();

            expect(result).toEqual({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            });
        });

        it('returns null when file has invalid JSON', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('not-json');

            const result = loadGmailAllowlist();

            expect(result).toBeNull();
        });

        it('returns null when allowedGroups is missing', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            const result = loadGmailAllowlist();

            expect(result).toBeNull();
        });

        it('returns null when allowedUsers is missing', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowAll: false,
            }));

            const result = loadGmailAllowlist();

            expect(result).toBeNull();
        });

        it('returns null when allowAll is not a boolean', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: 'yes',
            }));

            const result = loadGmailAllowlist();

            expect(result).toBeNull();
        });

        it('caches the result across calls', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            loadGmailAllowlist();
            loadGmailAllowlist();

            // The file should only be read once
            expect(mockReadFileSync).toHaveBeenCalledTimes(1);
        });
    });

    describe('isGmailAllowed', () => {
        it('returns false when no allowlist file exists', () => {
            mockExistsSync.mockReturnValue(false);

            expect(isGmailAllowed('main', ['123@s.whatsapp.net'])).toBe(false);
        });

        it('returns true when allowAll is true', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: [],
                allowedUsers: [],
                allowAll: true,
            }));

            expect(isGmailAllowed('any-group', ['any-user'])).toBe(true);
        });

        it('returns true when group AND user are both in the allowlist', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main', 'family'],
                allowedUsers: ['123@s.whatsapp.net', '456@s.whatsapp.net'],
                allowAll: false,
            }));

            expect(isGmailAllowed('main', ['123@s.whatsapp.net'])).toBe(true);
        });

        it('returns false when group is in list but user is NOT', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            expect(isGmailAllowed('main', ['999@s.whatsapp.net'])).toBe(false);
        });

        it('returns false when user is in list but group is NOT', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            expect(isGmailAllowed('other-group', ['123@s.whatsapp.net'])).toBe(false);
        });

        it('returns false when both lists are empty', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: [],
                allowedUsers: [],
                allowAll: false,
            }));

            expect(isGmailAllowed('main', ['123@s.whatsapp.net'])).toBe(false);
        });

        it('returns true if at least one sender is allowed', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            // Multiple senders — only one needs to match
            expect(isGmailAllowed('main', ['999@s.whatsapp.net', '123@s.whatsapp.net'])).toBe(true);
        });

        it('returns false when senders array is empty', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                allowedGroups: ['main'],
                allowedUsers: ['123@s.whatsapp.net'],
                allowAll: false,
            }));

            expect(isGmailAllowed('main', [])).toBe(false);
        });
    });
});
