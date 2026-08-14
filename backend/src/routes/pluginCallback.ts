import { Router } from 'express';
import { verifySecret } from '../plugins/remoteRegistry';
import { resolvePending } from '../plugins/pendingReplies';
import { sendMessage } from '../whatsapp';

export const pluginCallbackRouter = Router();

// Plugin -> main: the async reply to a message dispatched via
// remotePlugin.ts's POST {baseUrl}/on-message. `pluginId` is required here
// (alongside the secret) the same way it is for /plugins/heartbeat — it's
// what lets us verify the secret and cross-check the requestId actually
// belongs to this plugin before acting on it.
pluginCallbackRouter.post('/plugins/callback', async (req, res) => {
  const { pluginId, requestId, chatJid, reply } = req.body ?? {};
  const secret = req.header('X-Plugin-Secret');

  if (typeof pluginId !== 'string' || !pluginId.trim()) {
    res.status(400).json({ error: '"pluginId" is a required non-empty string.' });
    return;
  }
  if (!verifySecret(pluginId, secret)) {
    res.status(401).json({ error: 'Invalid pluginId or secret.' });
    return;
  }
  if (
    typeof requestId !== 'string' ||
    !requestId.trim() ||
    typeof chatJid !== 'string' ||
    !chatJid.trim() ||
    typeof reply !== 'string' ||
    !reply.trim()
  ) {
    res.status(400).json({ error: '"requestId", "chatJid", and a non-empty "reply" are required.' });
    return;
  }

  const result = resolvePending(requestId, pluginId);
  if (!result.ok) {
    if (result.reason === 'wrong_plugin') {
      res.status(403).json({ error: 'requestId does not belong to this plugin.' });
    } else {
      res.status(410).json({ error: 'Unknown, expired, or superseded requestId.' });
    }
    return;
  }

  try {
    // Send to the chatJid the request was actually dispatched for (from the
    // trusted pending record), not whatever the callback body claims.
    await sendMessage(result.chatJid, reply);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send reply.' });
  }
});
