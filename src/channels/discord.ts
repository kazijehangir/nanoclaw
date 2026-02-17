import { exec } from 'child_process';
import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  DMChannel,
  PartialMessage,
  ChannelType,
  Partials,
} from 'discord.js';

import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Discord Channel implementation
 *
 * JID format:
 * - DM channels: {userId}@discord.dm
 * - Server channels: {channelId}@discord
 * - Server context (for metadata): {guildId}@discord.guild
 */
export class DiscordChannel implements Channel {
  name = 'discord';
  prefixAssistantName = false; // Discord shows bot name automatically

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once('ready', () => {
        this.connected = true;
        logger.info({ bot: this.client.user?.tag }, 'Discord connected');

        // Set up message handler
        this.client.on('messageCreate', (message) => {
          this.handleMessage(message).catch((err) => {
            logger.error(
              { err, messageId: message.id },
              'Error handling Discord message',
            );
          });
        });

        resolve();
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.on('disconnect', () => {
        this.connected = false;
        logger.warn('Discord disconnected');
        exec(
          `osascript -e 'display notification "Discord disconnected" with title "NanoClaw" sound name "Basso"'`,
        );
      });

      this.client.login(this.opts.token).catch((err) => {
        logger.error({ err }, 'Discord login failed');
        reject(err);
      });
    });
  }

  private async handleMessage(
    message: Message | PartialMessage,
  ): Promise<void> {
    logger.debug(
      {
        messageId: message.id,
        author: message.author?.tag,
        content: message.content?.substring(0, 50),
        channelType: message.channel.type,
      },
      'Discord message received',
    );

    // Ignore bot messages
    if (message.author?.bot) {
      logger.debug('Ignoring bot message');
      return;
    }

    // Ignore empty messages
    if (!message.content) {
      logger.debug('Ignoring empty message');
      return;
    }

    const chatJid = this.messageToJid(message);
    const timestamp = message.createdAt.toISOString();

    // Deliver chat metadata
    const chatName = this.getChatName(message);
    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    // Deliver message
    const newMessage = {
      id: message.id,
      chat_jid: chatJid,
      sender: message.author?.id || 'unknown',
      sender_name: message.author?.username || 'Unknown',
      content: message.content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, newMessage);
  }

  private messageToJid(message: Message | PartialMessage): string {
    if (message.channel.type === ChannelType.DM) {
      return `${message.author?.id}@discord.dm`;
    } else {
      return `${message.channelId}@discord`;
    }
  }

  private getChatName(message: Message | PartialMessage): string {
    if (message.channel.type === ChannelType.DM) {
      return `DM: ${message.author?.username}`;
    } else if (message.channel.type === ChannelType.GuildText) {
      const channel = message.channel as TextChannel;
      return `${channel.guild.name} #${channel.name}`;
    } else {
      return 'Discord Channel';
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    this.outgoingQueue.push({ jid, text });
    if (!this.flushing) {
      this.flushQueue().catch((err) => {
        logger.error({ err }, 'Error flushing Discord queue');
      });
    }
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      while (this.outgoingQueue.length > 0) {
        const { jid, text } = this.outgoingQueue.shift()!;

        try {
          const channel = await this.resolveChannel(jid);
          if (!channel) {
            logger.warn({ jid }, 'Discord channel not found');
            continue;
          }

          // Split long messages (Discord has 2000 char limit)
          const chunks = this.splitMessage(text, 2000);
          for (const chunk of chunks) {
            await channel.send(chunk);
            // Small delay between chunks to avoid rate limiting
            if (chunks.length > 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        } catch (err) {
          logger.error({ err, jid }, 'Failed to send Discord message');
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async resolveChannel(
    jid: string,
  ): Promise<TextChannel | DMChannel | null> {
    if (jid.endsWith('@discord.dm')) {
      const userId = jid.split('@')[0];
      try {
        const user = await this.client.users.fetch(userId);
        return await user.createDM();
      } catch (err) {
        logger.error({ err, userId }, 'Failed to create DM');
        return null;
      }
    } else if (jid.endsWith('@discord')) {
      const channelId = jid.split('@')[0];
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (
          channel?.type === ChannelType.GuildText ||
          channel?.type === ChannelType.DM
        ) {
          return channel as TextChannel | DMChannel;
        }
        return null;
      } catch (err) {
        logger.error({ err, channelId }, 'Failed to fetch channel');
        return null;
      }
    }
    return null;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good newline, try space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good space, just hard cut
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex + 1);
    }

    return chunks;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord typing stops automatically

    try {
      const channel = await this.resolveChannel(jid);
      if (channel) {
        await channel.sendTyping();
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to set typing indicator');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@discord') || jid.endsWith('@discord.dm');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.client.destroy();
    logger.info('Discord disconnected');
  }
}
