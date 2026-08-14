import { z } from 'zod';
import { Plugin } from './types';

const configSchema = z.object({
  keyword: z.string().min(1).describe('Word or phrase to watch for in incoming messages (case-insensitive substring match)'),
  reply: z.string().min(1).describe('Message to send back when the keyword is found'),
});

type KeywordResponderConfig = z.infer<typeof configSchema>;

export const keywordResponderPlugin: Plugin<KeywordResponderConfig> = {
  id: 'keyword-responder',
  name: 'Keyword Auto-Responder',
  description: 'Replies with a fixed message whenever an incoming message contains a configured keyword (case-insensitive).',
  configSchema,
  onMessage(ctx) {
    if (!ctx.message.text) return;
    if (ctx.message.text.toLowerCase().includes(ctx.config.keyword.toLowerCase())) {
      return ctx.config.reply;
    }
  },
};
