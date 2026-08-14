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
  configSchema?: z.ZodType<TConfig>;
  // Return a non-empty string to send it back to the conversation; return
  // undefined/void/whitespace-only to send nothing.
  onMessage(ctx: PluginContext<TConfig>): Promise<string | void> | string | void;
}

export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  configJsonSchema?: object;
}
