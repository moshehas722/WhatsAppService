import { Router } from 'express';
import {
  getConversationMessages,
  getQrImage,
  getStatus,
  listConversations,
  listGroups,
  listPluginAssignments,
  logout,
  normalizeChatId,
  requestMoreHistory,
  sendMessage,
} from '../whatsapp';
import * as pluginManager from '../plugins/manager';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true });
});

apiRouter.get('/status', (_req, res) => {
  res.json({ state: getStatus() });
});

apiRouter.get('/qr', async (_req, res) => {
  const status = getStatus();

  if (status === 'connected') {
    res.status(409).json({ error: 'Already connected, no QR code needed.' });
    return;
  }

  const qrImage = await getQrImage();
  if (!qrImage) {
    res.status(202).json({ message: 'QR code not generated yet, try again shortly.' });
    return;
  }

  res.type('image/png').send(qrImage);
});

apiRouter.get('/groups', async (_req, res) => {
  try {
    const groups = await listGroups();
    res.json({ count: groups.length, groups });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to list groups.';
    const notConnected = err instanceof Error && errMessage.includes('not connected');
    res.status(notConnected ? 503 : 500).json({ error: errMessage, state: getStatus() });
  }
});

apiRouter.get('/conversations', (_req, res) => {
  const conversations = listConversations();
  res.json({ count: conversations.length, conversations });
});

apiRouter.get('/messages/:to', (req, res) => {
  const { to } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);

  try {
    const messages = getConversationMessages(to, limit);
    res.json({ to, count: messages.length, messages });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "to" value.' });
  }
});

apiRouter.post('/messages/:to/history', async (req, res) => {
  const { to } = req.params;
  const count = Math.min(Math.max(Number(req.body?.count) || 50, 1), 500);

  try {
    await requestMoreHistory(to, count);
    res.json({ requested: true, note: 'Older messages arrive asynchronously; poll GET /messages/:to shortly after.' });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to request history.';
    const notConnected = err instanceof Error && errMessage.includes('not connected');
    res.status(notConnected ? 503 : 400).json({ error: errMessage, state: getStatus() });
  }
});

apiRouter.get('/plugins', (_req, res) => {
  const plugins = pluginManager.listAvailablePlugins();
  res.json({ count: plugins.length, plugins });
});

// For the plugin-management screen: every conversation with a plugin attached.
apiRouter.get('/plugins/assignments', (_req, res) => {
  const assignments = listPluginAssignments();
  res.json({ count: assignments.length, assignments });
});

apiRouter.get('/conversations/:to/plugin', (req, res) => {
  const { to } = req.params;
  try {
    const assignment = pluginManager.getAssignment(normalizeChatId(to)) ?? null;
    res.json({ to, assignment });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "to" value.' });
  }
});

apiRouter.put('/conversations/:to/plugin', (req, res) => {
  const { to } = req.params;
  const { pluginId, config } = req.body ?? {};

  if (typeof pluginId !== 'string' || !pluginId.trim()) {
    res.status(400).json({ error: '"pluginId" is a required non-empty string.' });
    return;
  }

  try {
    const chatJid = normalizeChatId(to);
    const result = pluginManager.assignPlugin(chatJid, pluginId, config);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "to" value.' });
  }
});

apiRouter.patch('/conversations/:to/plugin', (req, res) => {
  const { to } = req.params;
  const { enabled } = req.body ?? {};

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: '"enabled" is a required boolean.' });
    return;
  }

  try {
    const result = pluginManager.setEnabled(normalizeChatId(to), enabled);
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "to" value.' });
  }
});

apiRouter.delete('/conversations/:to/plugin', (req, res) => {
  const { to } = req.params;
  try {
    pluginManager.clearAssignment(normalizeChatId(to));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "to" value.' });
  }
});

apiRouter.post('/logout', async (_req, res) => {
  try {
    await logout();
    res.json({ success: true, message: 'Logged out. A new QR code will be generated shortly — poll GET /status and GET /qr.' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to logout.' });
  }
});

apiRouter.post('/send', async (req, res) => {
  const { to, message } = req.body ?? {};
  console.log(`[send] request received: to=${to ?? '(missing)'} state=${getStatus()}`);

  if (typeof to !== 'string' || !to.trim() || typeof message !== 'string' || !message.trim()) {
    console.warn('[send] rejected: missing/invalid "to" or "message" in body');
    res.status(400).json({ error: '"to" and "message" are required non-empty strings.', state: getStatus() });
    return;
  }

  try {
    await sendMessage(to, message);
    console.log(`[send] success: message delivered to ${to}`);
    res.json({ success: true });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Failed to send message.';
    const notConnected = err instanceof Error && errMessage.includes('not connected');
    console.error(`[send] failed (state=${getStatus()}, notConnected=${notConnected}):`, err);
    res.status(notConnected ? 503 : 500).json({ error: errMessage, state: getStatus() });
  }
});
