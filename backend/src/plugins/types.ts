import { z } from 'zod';

export interface PluginMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  sender: string;
  senderName?: string;
  timestamp: number;
  text: string;
}

export interface PluginContext<TConfig = unknown> {
  chatJid: string;
  // The triggering message — always the last entry in `history`.
  message: PluginMessage;
  // Chronological (oldest -> newest), up to PLUGIN_HISTORY_LIMIT messages.
  history: PluginMessage[];
  // This conversation's saved config for this plugin, or undefined if the
  // plugin declares no configSchema.
  config: TConfig;
}

export interface Plugin<TConfig = unknown> {
  id: string;
  name: string;
  description: string;
  // Local (in-process) plugins declare a zod schema. Remote plugins (see
  // remotePlugin.ts) can only supply a plain JSON Schema object instead,
  // since there's no shared zod runtime across a network boundary — at most
  // one of these two should be set. Use plugins/configSchema.ts's helpers
  // rather than reading these directly.
  configSchema?: z.ZodType<TConfig>;
  configJsonSchema?: object;
  // Return a non-empty string to send it back to the conversation; return
  // undefined/void/whitespace-only to send nothing. For a remote plugin this
  // always resolves undefined immediately — the real reply (if any) arrives
  // later via the async callback route, not through this return value.
  onMessage(ctx: PluginContext<TConfig>): Promise<string | void> | string | void;
}

export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  configJsonSchema?: object;
  remote: boolean;
  healthy?: boolean;
  lastSeenAt?: number;
}
