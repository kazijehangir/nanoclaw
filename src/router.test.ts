import { describe, it, expect, vi } from 'vitest';
import { routeOutbound } from './router.js';
import { Channel } from './types.js';

// Mock Channel factory
const createMockChannel = (overrides: Partial<Channel> = {}): Channel => ({
  name: 'mock-channel',
  connect: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  ownsJid: vi.fn().mockReturnValue(true),
  disconnect: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('routeOutbound', () => {
  it('should send a message via the correct channel', async () => {
    const channel1 = createMockChannel({ ownsJid: vi.fn().mockReturnValue(false) });
    const channel2 = createMockChannel({ ownsJid: vi.fn().mockReturnValue(true) });
    const channels = [channel1, channel2];
    const jid = 'user@example.com';
    const text = 'Hello world';

    await routeOutbound(channels, jid, text);

    expect(channel1.sendMessage).not.toHaveBeenCalled();
    expect(channel2.sendMessage).toHaveBeenCalledWith(jid, text);
  });

  it('should throw if no channel owns the JID', () => {
    const channel1 = createMockChannel({ ownsJid: vi.fn().mockReturnValue(false) });
    const channels = [channel1];
    const jid = 'user@example.com';

    expect(() => routeOutbound(channels, jid, 'text')).toThrow(`No channel for JID: ${jid}`);
  });

  it('should throw if channel owns JID but is not connected', () => {
    const channel1 = createMockChannel({
      ownsJid: vi.fn().mockReturnValue(true),
      isConnected: vi.fn().mockReturnValue(false)
    });
    const channels = [channel1];
    const jid = 'user@example.com';

    expect(() => routeOutbound(channels, jid, 'text')).toThrow(`No channel for JID: ${jid}`);
  });

  it('should pick the first connected channel if multiple own the JID', async () => {
    const channel1 = createMockChannel({
      name: 'c1',
      ownsJid: vi.fn().mockReturnValue(true),
      isConnected: vi.fn().mockReturnValue(true)
    });
    const channel2 = createMockChannel({
      name: 'c2',
      ownsJid: vi.fn().mockReturnValue(true),
      isConnected: vi.fn().mockReturnValue(true)
    });
    const channels = [channel1, channel2];

    await routeOutbound(channels, 'user@example.com', 'text');

    expect(channel1.sendMessage).toHaveBeenCalled();
    expect(channel2.sendMessage).not.toHaveBeenCalled();
  });

  it('should pick the connected channel over a disconnected one that also owns the JID', async () => {
    const disconnected = createMockChannel({
      ownsJid: vi.fn().mockReturnValue(true),
      isConnected: vi.fn().mockReturnValue(false)
    });
    const connected = createMockChannel({
      ownsJid: vi.fn().mockReturnValue(true),
      isConnected: vi.fn().mockReturnValue(true)
    });

    // Order matters in find, but disconnected one should be skipped
    const channels = [disconnected, connected];

    await routeOutbound(channels, 'user@example.com', 'text');

    expect(disconnected.sendMessage).not.toHaveBeenCalled();
    expect(connected.sendMessage).toHaveBeenCalled();
  });
});
