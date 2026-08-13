import fs from 'fs';
import path from 'path';

export interface StoredMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  sender: string;
  timestamp: number;
  text: string;
}

const MAX_MESSAGES_PER_CHAT = 500;
const STORE_DIR = path.join(process.cwd(), 'auth_info', 'messages');

// Keyed by message id (falls back to a composite key if id is missing) so
// re-delivery — e.g. history backfill re-sending a message already seen live —
// overwrites in place instead of creating a duplicate.
const messagesByChat = new Map<string, Map<string, StoredMessage>>();
const dirtyChats = new Set<string>();

function messageKey(message: StoredMessage): string {
  return message.id || `${message.timestamp}-${message.sender}`;
}

function sortedByTime(chatMap: Map<string, StoredMessage>): StoredMessage[] {
  return [...chatMap.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function fileForChat(chatJid: string): string {
  const safe = chatJid.replace(/[^a-zA-Z0-9.@-]/g, '_');
  return path.join(STORE_DIR, `${safe}.json`);
}

// Call once at startup to warm the in-memory store from previously persisted
// conversations, so history survives a server restart.
export function loadPersistedMessages(): void {
  if (!fs.existsSync(STORE_DIR)) return;

  let loadedChats = 0;
  let loadedMessages = 0;
  for (const file of fs.readdirSync(STORE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const messages: StoredMessage[] = JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), 'utf8'));
      if (!messages.length) continue;
      const chatMap = new Map<string, StoredMessage>();
      for (const m of messages) {
        chatMap.set(messageKey(m), m);
      }
      messagesByChat.set(messages[0].chatJid, chatMap);
      loadedChats += 1;
      loadedMessages += chatMap.size;
    } catch (err) {
      console.error(`[messageStore] failed to load ${file}:`, err);
    }
  }
  if (loadedChats > 0) {
    console.error(`[messageStore] loaded ${loadedMessages} message(s) across ${loadedChats} conversation(s) from disk`);
  }
}

function persistChat(chatJid: string): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const messages = sortedByTime(messagesByChat.get(chatJid) ?? new Map());
    fs.writeFileSync(fileForChat(chatJid), JSON.stringify(messages));
  } catch (err) {
    console.error(`[messageStore] failed to persist chat ${chatJid}:`, err);
  }
}

// Writes are batched per event (see flushDirty) rather than per message, so a
// history backfill of hundreds of messages doesn't do hundreds of disk writes.
export function addMessage(message: StoredMessage): void {
  let chatMap = messagesByChat.get(message.chatJid);
  if (!chatMap) {
    chatMap = new Map();
    messagesByChat.set(message.chatJid, chatMap);
  }
  chatMap.set(messageKey(message), message);

  if (chatMap.size > MAX_MESSAGES_PER_CHAT) {
    const oldestFirst = sortedByTime(chatMap);
    for (const stale of oldestFirst.slice(0, chatMap.size - MAX_MESSAGES_PER_CHAT)) {
      chatMap.delete(messageKey(stale));
    }
  }
  dirtyChats.add(message.chatJid);
}

export function flushDirty(): void {
  for (const chatJid of dirtyChats) {
    persistChat(chatJid);
  }
  dirtyChats.clear();
}

// Chronological order, oldest first — matches chat-UI convention of
// appending newer messages at the bottom.
export function getMessages(chatJid: string, limit = 50): StoredMessage[] {
  const chatMap = messagesByChat.get(chatJid);
  if (!chatMap) return [];
  return sortedByTime(chatMap).slice(-limit);
}

export function getOldestMessage(chatJid: string): StoredMessage | undefined {
  const chatMap = messagesByChat.get(chatJid);
  if (!chatMap || chatMap.size === 0) return undefined;
  return sortedByTime(chatMap)[0];
}

export interface ConversationSummary {
  chatJid: string;
  count: number;
  lastTimestamp: number;
  lastText: string;
  lastFromMe: boolean;
}

// Every chat with at least one stored message, most recently active first.
export function listConversations(): ConversationSummary[] {
  const summaries: ConversationSummary[] = [];
  for (const [chatJid, chatMap] of messagesByChat) {
    if (chatMap.size === 0) continue;
    const messages = sortedByTime(chatMap);
    const last = messages[messages.length - 1];
    summaries.push({ chatJid, count: messages.length, lastTimestamp: last.timestamp, lastText: last.text, lastFromMe: last.fromMe });
  }
  return summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}
