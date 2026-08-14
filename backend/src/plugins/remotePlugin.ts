import crypto from 'crypto';
import { Plugin, PluginContext } from './types';
import { RemotePluginRegistration } from './remoteRegistry';
import { registerPending } from './pendingReplies';

const PLUGIN_ACK_TIMEOUT_MS = Number(process.env.PLUGIN_ACK_TIMEOUT_MS) || 5000;

// Wraps a remote plugin registration as something conforming to the local
// Plugin interface, so registry.ts/manager.ts don't need to know the
// difference. Stateless — cheap to construct fresh per lookup.
export function createRemotePluginAdapter(registration: RemotePluginRegistration): Plugin {
  return {
    id: registration.pluginId,
    name: registration.name,
    description: registration.description,
    configJsonSchema: registration.configJsonSchema,

    // Always resolves undefined, regardless of whether the ack succeeded —
    // the real reply (if any) arrives later via POST /plugins/callback, not
    // through this return value. See plugins/pendingReplies.ts for the
    // correlation/expiry/supersede mechanics.
    async onMessage(ctx: PluginContext): Promise<undefined> {
      const requestId = crypto.randomUUID();
      registerPending(requestId, registration.pluginId, ctx.chatJid);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PLUGIN_ACK_TIMEOUT_MS);
      try {
        const res = await fetch(`${registration.baseUrl}/on-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': registration.secret },
          body: JSON.stringify({
            requestId,
            chatJid: ctx.chatJid,
            message: ctx.message,
            history: ctx.history,
            config: ctx.config,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          console.error(`[remotePlugin] ${registration.pluginId} /on-message returned ${res.status}`);
        }
      } catch (err) {
        console.error(`[remotePlugin] ${registration.pluginId} /on-message unreachable:`, err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timeout);
      }

      return undefined;
    },
  };
}
