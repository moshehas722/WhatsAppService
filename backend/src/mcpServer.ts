import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConversationMessages, getQrImage, getStatus, listConversations, listGroups, logout, requestMoreHistory, sendMessage } from './whatsapp';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'whatsapp-sender', version: '1.0.0' });

  server.tool(
    'send_whatsapp_message',
    'Send a WhatsApp text message to a phone number. The number must include the country code (digits only, or with a leading +).',
    {
      to: z.string().describe('Recipient phone number with country code, e.g. "972501234567" or "+972501234567"'),
      message: z.string().describe('Text message body to send'),
    },
    async ({ to, message }) => {
      try {
        await sendMessage(to, message);
        return { content: [{ type: 'text', text: `Message sent to ${to}.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to send message.';
        return { content: [{ type: 'text', text: `Failed to send: ${msg}` }], isError: true };
      }
    },
  );

  server.tool('get_whatsapp_status', 'Get the current WhatsApp connection state (connecting, qr_pending, connected, disconnected).', {}, async () => {
    return { content: [{ type: 'text', text: `WhatsApp connection state: ${getStatus()}` }] };
  });

  server.tool(
    'get_whatsapp_qr',
    'Get the WhatsApp Web pairing QR code as an image, if a device link/scan is currently pending.',
    {},
    async () => {
      const status = getStatus();
      if (status === 'connected') {
        return { content: [{ type: 'text', text: 'Already connected — no QR code needed.' }] };
      }
      const qrImage = await getQrImage();
      if (!qrImage) {
        return { content: [{ type: 'text', text: `QR code not generated yet (state: ${status}). Try again shortly.` }] };
      }
      return { content: [{ type: 'image', data: qrImage.toString('base64'), mimeType: 'image/png' }] };
    },
  );

  server.tool(
    'list_whatsapp_groups',
    'List WhatsApp groups this account is currently a participant in, with their JIDs. Group JIDs (ending in @g.us) have no phone-number equivalent — use this to find the "with" value for get_whatsapp_messages / send_whatsapp_message when targeting a group.',
    {},
    async () => {
      try {
        const groups = await listGroups();
        if (groups.length === 0) {
          return { content: [{ type: 'text', text: 'Not currently a participant in any groups.' }] };
        }
        const formatted = groups.map((g) => `${g.subject} — ${g.id} (${g.size} participants)`).join('\n');
        return { content: [{ type: 'text', text: formatted }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to list groups.';
        return { content: [{ type: 'text', text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'list_whatsapp_conversations',
    'List conversations with at least one saved message (persisted locally, works even while disconnected), most recently active first. Use this to discover which phone numbers/group JIDs have history before calling get_whatsapp_messages.',
    {},
    async () => {
      const conversations = listConversations();
      if (conversations.length === 0) {
        return { content: [{ type: 'text', text: 'No saved conversations yet.' }] };
      }
      const formatted = conversations
        .map(
          (c) =>
            `${c.isGroup ? '[group] ' : ''}${c.chatJid} — ${c.count} message(s), last: [${new Date(c.lastTimestamp * 1000).toISOString()}] ${c.lastFromMe ? 'me' : 'them'}: ${c.lastText}`,
        )
        .join('\n');
      return { content: [{ type: 'text', text: formatted }] };
    },
  );

  server.tool(
    'get_whatsapp_messages',
    'Get recent messages from a WhatsApp conversation, either a 1:1 chat (phone number) or a group (JID from list_whatsapp_groups). Only messages sent/received since this server started (plus whatever WhatsApp backfills on connect) are available — this is not a full history export.',
    {
      with: z
        .string()
        .describe('Phone number with country code (e.g. "972501234567") for a 1:1 chat, or a group JID (e.g. "1203630...@g.us") from list_whatsapp_groups'),
      limit: z.number().int().positive().max(500).optional().describe('Max number of messages to return, most recent first (default 50)'),
    },
    async ({ with: to, limit }) => {
      try {
        const messages = getConversationMessages(to, limit ?? 50);
        if (messages.length === 0) {
          return {
            content: [
              { type: 'text', text: `No stored messages with ${to}. Only messages seen since this server started are captured.` },
            ],
          };
        }
        const formatted = messages
          .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] ${m.fromMe ? 'me' : m.sender}: ${m.text}`)
          .join('\n');
        return { content: [{ type: 'text', text: formatted }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to get messages.';
        return { content: [{ type: 'text', text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'request_whatsapp_history',
    'Request older messages for a conversation from WhatsApp (backfill). Requires at least one message already stored for this conversation (via get_whatsapp_messages) to anchor the request. Results arrive asynchronously — call get_whatsapp_messages again a moment later to see them.',
    {
      with: z.string().describe('The other party\'s phone number with country code, e.g. "972501234567"'),
      count: z.number().int().positive().max(500).optional().describe('Approximate number of older messages to request (default 50)'),
    },
    async ({ with: to, count }) => {
      try {
        await requestMoreHistory(to, count ?? 50);
        return {
          content: [
            { type: 'text', text: `History request sent for ${to}. Call get_whatsapp_messages again shortly to see the backfilled messages.` },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to request history.';
        return { content: [{ type: 'text', text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'logout_whatsapp',
    'Log out the linked WhatsApp device and clear the saved session. A new QR code will be generated for re-linking — disruptive, only use when explicitly asked to relink the device (e.g. to force a fuller history sync).',
    {},
    async () => {
      try {
        await logout();
        return { content: [{ type: 'text', text: 'Logged out. A new QR code will be generated shortly — call get_whatsapp_qr.' }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to logout.';
        return { content: [{ type: 'text', text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  return server;
}
