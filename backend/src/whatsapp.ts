import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeWASocket,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import {
  addMessage,
  ConversationSummary,
  flushContacts,
  flushDirty,
  getContactName,
  getMessages,
  getOldestMessage,
  listConversations as listStoredConversations,
  loadPersistedContacts,
  loadPersistedMessages,
  setContactName,
  StoredMessage,
} from './messageStore';

export type ConnectionState = 'connecting' | 'qr_pending' | 'connected' | 'disconnected';

const AUTH_DIR = path.join(process.cwd(), 'auth_info');
const logger = pino({ level: 'silent' });

// NOTE: always log via console.error (stderr). stdout is reserved for the MCP
// stdio transport's JSON-RPC framing (src/mcp.ts) — writing logs to stdout
// there would corrupt the protocol stream. The HTTP server (src/index.ts)
// doesn't care which stream logs go to, so stderr is safe for both entry points.
function log(...args: unknown[]) {
  console.error(...args);
}

// Run once per process — warms the in-memory message store from disk so
// conversation history survives a restart.
loadPersistedMessages();
loadPersistedContacts();

let sock: WASocket | undefined;
let state: ConnectionState = 'connecting';
let latestQr: string | undefined;
let connectPromise: Promise<void> | undefined;

// Guards against overlapping connectToWhatsApp() calls (e.g. a reconnect
// already in flight from a connection.update close event) racing to create
// two live sockets. Safe to call from anywhere that just wants "make sure
// we're (re)connecting" without caring whether one is already underway.
function ensureConnecting(): void {
  if (connectPromise) return;
  connectPromise = connectToWhatsApp().finally(() => {
    connectPromise = undefined;
  });
}

// Clears everything inside AUTH_DIR (session creds, messages, contacts,
// TLS cert) without removing AUTH_DIR itself — it's a Docker bind mount
// point (see docker-compose.yml), and removing a mount point directory
// fails with EBUSY even though clearing its contents is fine.
function clearAuthDir(): void {
  if (!fs.existsSync(AUTH_DIR)) return;
  for (const entry of fs.readdirSync(AUTH_DIR)) {
    fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
  }
}

function setState(next: ConnectionState) {
  if (state !== next) {
    log(`[whatsapp] state ${state} -> ${next}`);
  }
  state = next;
}

export function getStatus(): ConnectionState {
  return state;
}

export async function getQrImage(): Promise<Buffer | undefined> {
  if (!latestQr) return undefined;
  return qrcode.toBuffer(latestQr, { type: 'png' });
}

function extractText(message: proto.IMessage | null | undefined): string {
  const normalized = message ? normalizeMessageContent(message) : undefined;
  if (!normalized) return '';
  const type = getContentType(normalized);

  switch (type) {
    case 'conversation':
      return normalized.conversation ?? '';
    case 'extendedTextMessage':
      return normalized.extendedTextMessage?.text ?? '';
    case 'imageMessage':
      return normalized.imageMessage?.caption ? `[image] ${normalized.imageMessage.caption}` : '[image]';
    case 'videoMessage':
      return normalized.videoMessage?.caption ? `[video] ${normalized.videoMessage.caption}` : '[video]';
    case 'documentMessage':
      return normalized.documentMessage?.caption
        ? `[document] ${normalized.documentMessage.caption}`
        : `[document] ${normalized.documentMessage?.fileName ?? ''}`;
    case 'audioMessage':
      return normalized.audioMessage?.ptt ? '[voice note]' : '[audio]';
    case 'stickerMessage':
      return '[sticker]';
    case 'contactMessage':
      return `[contact] ${normalized.contactMessage?.displayName ?? ''}`;
    case 'locationMessage':
      return '[location]';
    case 'reactionMessage':
      return `[reaction] ${normalized.reactionMessage?.text ?? ''}`;
    default:
      return type ? `[${type}]` : '[unsupported message]';
  }
}

function storeIncomingMessages(messages: WAMessage[], source: string) {
  let stored = 0;
  let contactsChanged = false;
  for (const msg of messages) {
    const chatJid = msg.key.remoteJid;
    if (!msg.message || !chatJid) continue;
    const timestamp =
      typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp ?? 0);
    const sender = msg.key.participant ?? chatJid;
    const record: StoredMessage = {
      id: msg.key.id ?? '',
      chatJid,
      fromMe: !!msg.key.fromMe,
      sender,
      timestamp,
      text: extractText(msg.message),
    };
    addMessage(record);
    stored += 1;

    // pushName is the display name the sender's own device reports — not as
    // reliable as a saved contact name (see contacts.upsert/update below),
    // but it's the only name info available for chats without a synced
    // contact, so use it as a fallback.
    if (!msg.key.fromMe && setContactName(sender, msg.pushName)) contactsChanged = true;
  }
  if (stored > 0) {
    flushDirty();
    log(`[whatsapp] ${source}: stored ${stored} message(s)`);
  }
  if (contactsChanged) flushContacts();
}

export async function connectToWhatsApp(): Promise<void> {
  log(`[whatsapp] connecting... (auth dir: ${AUTH_DIR}, exists: ${fs.existsSync(AUTH_DIR)})`);
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log(`[whatsapp] using Baileys WA version ${version.join('.')} (isLatest=${isLatest})`);

  sock = makeWASocket({
    auth: authState,
    version,
    logger,
    syncFullHistory: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    storeIncomingMessages(messages, 'messages.upsert');
  });

  sock.ev.on('messaging-history.set', ({ messages, isLatest }) => {
    storeIncomingMessages(messages, `messaging-history.set (isLatest=${isLatest})`);
  });

  // Saved-contact names (from the linked phone's address book), synced in
  // bulk on first connect and incrementally afterward. Preferred over
  // pushName when available since it's the name *you* gave the contact.
  sock.ev.on('contacts.upsert', (contacts) => {
    let changed = false;
    for (const c of contacts) {
      if (setContactName(c.id, c.name || c.notify)) changed = true;
    }
    if (changed) flushContacts();
  });

  sock.ev.on('contacts.update', (updates) => {
    let changed = false;
    for (const u of updates) {
      if (u.id && setContactName(u.id, u.name || u.notify)) changed = true;
    }
    if (changed) flushContacts();
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    log(`[whatsapp] connection.update: connection=${connection ?? 'undefined'} qr=${qr ? 'present' : 'none'}`);

    if (qr) {
      latestQr = qr;
      setState('qr_pending');
      qrcodeTerminal.generate(qr, { small: true }, (rendered) => log(rendered));
      log('Scan the QR code above with WhatsApp (Linked Devices > Link a Device), or call get_whatsapp_qr / GET /qr for an image.');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log(`[whatsapp] connection closed. statusCode=${statusCode ?? 'unknown'} loggedOut=${loggedOut}`, lastDisconnect?.error);

      if (loggedOut) {
        log('[whatsapp] logged out. Clearing session, a new QR code will be generated.');
        clearAuthDir();
      } else {
        log('[whatsapp] reconnecting...');
      }
      setState('connecting');
      ensureConnecting();
    } else if (connection === 'open') {
      setState('connected');
      latestQr = undefined;
      log('[whatsapp] connected to WhatsApp.');
    }
  });
}

export async function logout(): Promise<void> {
  if (!sock) {
    throw new Error('WhatsApp socket not initialized yet.');
  }
  log(`[whatsapp] logout requested (currentState=${state})`);
  try {
    await sock.logout();
  } catch (err) {
    // sock.logout() needs a live websocket to ask WhatsApp's servers to
    // unlink the device — if we're mid-reconnect (state !== 'connected'),
    // it fails immediately with "Connection Closed" before ever reaching
    // WhatsApp. In that case the socket is already internally marked
    // closed, so sock.end() is a silent no-op (Baileys short-circuits on
    // its own `closed` flag) — it will NOT emit connection.update and
    // nothing will clear the session or reconnect. So do that ourselves
    // directly instead of routing through the socket's close event.
    // Note: the device won't be actively unlinked from the phone's Linked
    // Devices list in this case — it'll just go stale until WhatsApp times
    // it out on its own.
    log('[whatsapp] sock.logout() failed (likely no live connection), forcing local session reset:', err);
    clearAuthDir();
    setState('connecting');
    ensureConnecting();
  }
}

export function toJid(to: string): string {
  const digitsOnly = to.replace(/\D/g, '');
  if (!digitsOnly) {
    throw new Error('Invalid phone number: must contain digits (include country code, no leading +/0).');
  }
  return `${digitsOnly}@s.whatsapp.net`;
}

/**
 * Accepts either a phone number ("972501234567") for a 1:1 chat, or an
 * already-fully-qualified JID (e.g. a group JID like "1203630...@g.us",
 * which has no phone-number equivalent — get it from listGroups()).
 */
export function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  return trimmed.includes('@') ? trimmed : toJid(trimmed);
}

export interface GroupSummary {
  id: string;
  subject: string;
  size: number;
}

export async function listGroups(): Promise<GroupSummary[]> {
  if (!sock || state !== 'connected') {
    throw new Error(`WhatsApp is not connected yet (state=${state}). Scan the QR code first (see /status, /qr).`);
  }
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map((g) => ({ id: g.id, subject: g.subject, size: g.participants?.length ?? 0 }));
}

export interface ConversationMessage extends StoredMessage {
  senderName?: string;
}

// Resolved at read time (not stored on the message) so a name learned after
// a message was saved — e.g. contacts sync completing later — still shows up.
export function getConversationMessages(to: string, limit = 50): ConversationMessage[] {
  return getMessages(normalizeChatId(to), limit).map((m) => ({ ...m, senderName: getContactName(m.sender) }));
}

export interface ConversationListItem extends ConversationSummary {
  isGroup: boolean;
  name?: string;
}

// Purely local — reads from the persisted store, no WhatsApp connection needed.
export function listConversations(): ConversationListItem[] {
  return listStoredConversations().map((c) => ({
    ...c,
    isGroup: c.chatJid.endsWith('@g.us'),
    name: getContactName(c.chatJid),
  }));
}

export async function requestMoreHistory(to: string, count = 50): Promise<void> {
  if (!sock || state !== 'connected') {
    throw new Error(`WhatsApp is not connected yet (state=${state}). Scan the QR code first (see /status, /qr).`);
  }
  const jid = normalizeChatId(to);
  const oldest = getOldestMessage(jid);
  if (!oldest) {
    throw new Error(
      `No messages captured yet for ${to} — at least one message in this conversation must already be stored to anchor the history request. Send or receive one message first, then retry.`,
    );
  }
  log(`[whatsapp] requesting ${count} more history message(s) for jid=${jid} before ts=${oldest.timestamp}`);
  await sock.fetchMessageHistory(
    count,
    { remoteJid: jid, id: oldest.id, fromMe: oldest.fromMe, participant: oldest.sender !== jid ? oldest.sender : undefined },
    oldest.timestamp,
  );
  log(`[whatsapp] history request sent for jid=${jid}; results arrive asynchronously via messaging-history.set`);
}

export async function sendMessage(to: string, message: string): Promise<void> {
  log(`[whatsapp] sendMessage called: to=${to} currentState=${state} sockReady=${!!sock}`);
  if (!sock || state !== 'connected') {
    throw new Error(`WhatsApp is not connected yet (state=${state}). Scan the QR code first (see /status, /qr).`);
  }
  const jid = normalizeChatId(to);
  log(`[whatsapp] sending to jid=${jid}`);
  await sock.sendMessage(jid, { text: message });
  log(`[whatsapp] sock.sendMessage resolved for jid=${jid}`);
}
