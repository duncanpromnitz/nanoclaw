/**
 * Slack channel adapter (v2, Socket Mode) — uses @slack/bolt.
 * Socket Mode requires no public URL — the bot opens an outbound WebSocket.
 * Self-registers on import.
 */
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, OutboundMessage } from './adapter.js';

// Slack's chat.postMessage limit
const MAX_MESSAGE_LENGTH = 4000;

type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

class SlackSocketAdapter implements ChannelAdapter {
  readonly name = 'slack';
  readonly channelType = 'slack';
  // Flatten threads to channel level — responses always go to the channel
  readonly supportsThreads = false;

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private userNameCache = new Map<string, string>();
  private setup_config: ChannelSetup | null = null;

  constructor(botToken: string, appToken: string) {
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setup_config = config;

    this.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      const msg = event as HandledMessageEvent;
      if (!msg.text) return;

      const platformId = msg.channel;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Report channel metadata on every message for group discovery
      config.onMetadata(platformId, undefined, isGroup);

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      // ⏳ receipt acknowledgment — fire-and-forget, ignore errors
      if (!isBotMessage && msg.ts) {
        this.app.client.reactions
          .add({ channel: platformId, timestamp: msg.ts, name: 'hourglass_flowing_sand' })
          .catch(() => {});
      }

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName = (msg.user ? await this.resolveUserName(msg.user) : undefined) ?? msg.user ?? 'unknown';
      }

      // Translate <@UBOTID> mentions into trigger format
      let text = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (text.includes(mentionPattern) && !TRIGGER_PATTERN.test(text)) {
          text = `@${ASSISTANT_NAME} ${text}`;
        }
      }

      const isMention = text.startsWith(`@${ASSISTANT_NAME}`);

      config.onInbound(platformId, null, {
        id: msg.ts,
        kind: 'chat',
        content: {
          text,
          sender: senderName,
          senderId: `slack:${msg.user ?? msg.bot_id ?? ''}`,
          is_from_me: isBotMessage,
        },
        timestamp,
        isMention: isBotMessage ? false : isMention,
        isGroup,
      });
    });

    await this.app.start();

    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      log.info('Connected to Slack (Socket Mode)', { botUserId: this.botUserId });
    } catch (err) {
      log.warn('Connected to Slack but failed to get bot user ID', { err });
    }

    this.connected = true;
    await this.syncAndEmitMetadata();
  }

  async teardown(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const content = message.content as { text?: string };
    const text = content?.text;
    if (!text) return;

    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        const result = await this.app.client.chat.postMessage({ channel: platformId, text });
        log.info('Slack message sent', { platformId, length: text.length });
        return result.ts as string | undefined;
      } else {
        let firstTs: string | undefined;
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          const result = await this.app.client.chat.postMessage({
            channel: platformId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
          if (i === 0) firstTs = result.ts as string | undefined;
        }
        log.info('Slack message sent (chunked)', { platformId, length: text.length });
        return firstTs;
      }
    } catch (err) {
      log.warn('Failed to send Slack message', { platformId, err });
      throw err;
    }
  }

  async setTyping(_platformId: string, _threadId: string | null): Promise<void> {
    // Slack Bot API has no typing indicator endpoint
  }

  async syncConversations(): Promise<ConversationInfo[]> {
    const conversations: ConversationInfo[] = [];
    try {
      let cursor: string | undefined;
      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        for (const ch of result.channels ?? []) {
          if (ch.id && ch.name && ch.is_member) {
            conversations.push({ platformId: ch.id, name: ch.name, isGroup: true });
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      log.warn('Failed to sync Slack conversations', { err });
    }
    return conversations;
  }

  async resolveChannelName(platformId: string): Promise<string | null> {
    try {
      const result = await this.app.client.conversations.info({ channel: platformId });
      return (result.channel as { name?: string })?.name ?? null;
    } catch {
      return null;
    }
  }

  async openDM(userHandle: string): Promise<string> {
    const result = await this.app.client.conversations.open({ users: userHandle });
    const channel = result.channel as { id?: string };
    if (!channel?.id) throw new Error(`Failed to open DM with ${userHandle}`);
    return channel.id;
  }

  private async syncAndEmitMetadata(): Promise<void> {
    const conversations = await this.syncConversations();
    for (const conv of conversations) {
      this.setup_config?.onMetadata(conv.platformId, conv.name, conv.isGroup);
    }
    log.info('Slack channel metadata synced', { count: conversations.length });
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      log.debug('Failed to resolve Slack user name', { userId, err });
      return undefined;
    }
  }
}

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
      log.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set, skipping');
      return null;
    }
    return new SlackSocketAdapter(env.SLACK_BOT_TOKEN, env.SLACK_APP_TOKEN);
  },
});
