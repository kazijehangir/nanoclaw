/**
 * Gmail Security Module for NanoClaw
 *
 * Controls which groups and users can access Gmail tools.
 * Validates against an allowlist stored at gmail-allowlist.json
 * in the project root (alongside .env).
 */
import fs from 'fs';

import { GMAIL_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import { GmailAllowlist } from './types.js';

// Cache the allowlist in memory — only reloads on process restart
let cachedAllowlist: GmailAllowlist | null = null;
let allowlistLoadAttempted = false;

/**
 * Load the Gmail allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export function loadGmailAllowlist(): GmailAllowlist | null {
    if (allowlistLoadAttempted) {
        return cachedAllowlist;
    }
    allowlistLoadAttempted = true;

    try {
        if (!fs.existsSync(GMAIL_ALLOWLIST_PATH)) {
            logger.warn(
                { path: GMAIL_ALLOWLIST_PATH },
                'Gmail allowlist not found — Gmail tools will be BLOCKED for all groups. ' +
                'Create this file to enable Gmail access for specific groups/users.',
            );
            return null;
        }

        const content = fs.readFileSync(GMAIL_ALLOWLIST_PATH, 'utf-8');
        const allowlist = JSON.parse(content) as GmailAllowlist;

        // Validate structure
        if (!Array.isArray(allowlist.allowedGroups)) {
            throw new Error('allowedGroups must be an array');
        }

        if (!Array.isArray(allowlist.allowedUsers)) {
            throw new Error('allowedUsers must be an array');
        }

        if (typeof allowlist.allowAll !== 'boolean') {
            throw new Error('allowAll must be a boolean');
        }

        cachedAllowlist = allowlist;
        logger.info(
            {
                path: GMAIL_ALLOWLIST_PATH,
                allowedGroups: allowlist.allowedGroups.length,
                allowedUsers: allowlist.allowedUsers.length,
                allowAll: allowlist.allowAll,
            },
            'Gmail allowlist loaded successfully',
        );

        return cachedAllowlist;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
            { path: GMAIL_ALLOWLIST_PATH, error: errMsg },
            'Failed to load Gmail allowlist — Gmail tools will be BLOCKED',
        );
        return null;
    }
}

/**
 * Check if Gmail access is allowed for a given group folder and set of senders.
 *
 * Both checks must pass:
 *   1. The group folder must be in allowedGroups
 *   2. At least one sender must be in allowedUsers
 *
 * If allowAll is true, both checks are bypassed.
 * If no allowlist file exists, Gmail is blocked (safe default).
 */
export function isGmailAllowed(groupFolder: string, senders: string[]): boolean {
    const allowlist = loadGmailAllowlist();

    if (allowlist === null) {
        return false;
    }

    if (allowlist.allowAll) {
        return true;
    }

    // Check 1: group must be in the allowlist
    if (!allowlist.allowedGroups.includes(groupFolder)) {
        logger.debug(
            { groupFolder },
            'Gmail blocked: group not in allowedGroups',
        );
        return false;
    }

    // Check 2: at least one sender must be in the allowlist
    const hasAllowedSender = senders.some((s) => allowlist.allowedUsers.includes(s));
    if (!hasAllowedSender) {
        logger.debug(
            { groupFolder, senderCount: senders.length },
            'Gmail blocked: no sender in allowedUsers',
        );
        return false;
    }

    return true;
}

/**
 * Reset the cached allowlist (for testing).
 */
export function _resetGmailAllowlistCache(): void {
    cachedAllowlist = null;
    allowlistLoadAttempted = false;
}
