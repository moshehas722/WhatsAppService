import { Router } from 'express';
import * as remoteRegistry from '../plugins/remoteRegistry';
import { staticPluginIds } from '../plugins/registry';

export const pluginRegistrationRouter = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// Plugin -> main: a plugin container announces itself on startup. Idempotent
// upsert keyed by pluginId — see remoteRegistry.register() for the
// new-vs-existing-id secret handling.
pluginRegistrationRouter.post('/plugins/register', (req, res) => {
  const { pluginId, name, description, baseUrl, configJsonSchema } = req.body ?? {};

  if (!isNonEmptyString(pluginId) || !isNonEmptyString(name) || !isNonEmptyString(description) || !isNonEmptyString(baseUrl)) {
    res.status(400).json({ error: '"pluginId", "name", "description", and "baseUrl" are required non-empty strings.' });
    return;
  }
  if (configJsonSchema !== undefined && (typeof configJsonSchema !== 'object' || configJsonSchema === null)) {
    res.status(400).json({ error: '"configJsonSchema", if provided, must be an object.' });
    return;
  }
  if (staticPluginIds.has(pluginId)) {
    res.status(400).json({ error: `pluginId "${pluginId}" is reserved.` });
    return;
  }

  const presentedSecret = req.header('X-Plugin-Secret');
  const result = remoteRegistry.register(pluginId, { name, description, baseUrl, configJsonSchema }, presentedSecret);

  if ('error' in result) {
    res.status(409).json({ error: result.error });
    return;
  }

  const registration = remoteRegistry.get(pluginId);
  res.status(result.created ? 201 : 200).json({
    pluginId,
    secret: result.secret,
    registeredAt: registration?.registeredAt,
  });
});

pluginRegistrationRouter.delete('/plugins/register', (req, res) => {
  const { pluginId } = req.body ?? {};
  const secret = req.header('X-Plugin-Secret');

  if (!isNonEmptyString(pluginId)) {
    res.status(400).json({ error: '"pluginId" is a required non-empty string.' });
    return;
  }
  if (!remoteRegistry.unregister(pluginId, secret ?? '')) {
    res.status(401).json({ error: 'Invalid pluginId or secret.' });
    return;
  }
  res.json({ success: true });
});

pluginRegistrationRouter.post('/plugins/heartbeat', (req, res) => {
  const { pluginId } = req.body ?? {};
  const secret = req.header('X-Plugin-Secret');

  if (!isNonEmptyString(pluginId)) {
    res.status(400).json({ error: '"pluginId" is a required non-empty string.' });
    return;
  }
  if (!remoteRegistry.verifySecret(pluginId, secret)) {
    res.status(401).json({ error: 'Invalid pluginId or secret.' });
    return;
  }
  remoteRegistry.touchLastSeen(pluginId);
  res.json({ ok: true });
});
