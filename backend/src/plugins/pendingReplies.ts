// In-memory only (deliberately not persisted to disk) — if the main service
// restarts mid-flight, an in-flight remote-plugin reply is simply lost and
// the plugin's eventual callback gets a clean 410. That's an acceptable,
// already-precedented failure mode: the rest of the plugin system already
// tolerates silent drops (see manager.runAssignedPlugin's catch-and-log).

export const PENDING_REPLY_TTL_MS = Number(process.env.PLUGIN_PENDING_REPLY_TTL_MS) || 15 * 60 * 1000; // 15 min
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PendingReply {
  requestId: string;
  pluginId: string;
  chatJid: string;
  createdAt: number;
  expiresAt: number;
}

const byRequestId = new Map<string, PendingReply>();
// One entry per chat at most — used to implement the supersede rule: a new
// dispatch to a chat invalidates whatever was still pending for that chat.
const currentRequestIdByChat = new Map<string, string>();

function removeEntry(entry: PendingReply): void {
  byRequestId.delete(entry.requestId);
  if (currentRequestIdByChat.get(entry.chatJid) === entry.requestId) {
    currentRequestIdByChat.delete(entry.chatJid);
  }
}

export function registerPending(requestId: string, pluginId: string, chatJid: string): void {
  const superseded = currentRequestIdByChat.get(chatJid);
  if (superseded) {
    const entry = byRequestId.get(superseded);
    if (entry) removeEntry(entry);
  }

  const now = Date.now();
  const entry: PendingReply = { requestId, pluginId, chatJid, createdAt: now, expiresAt: now + PENDING_REPLY_TTL_MS };
  byRequestId.set(requestId, entry);
  currentRequestIdByChat.set(chatJid, requestId);
}

export type ResolveResult = { ok: true; chatJid: string } | { ok: false; reason: 'not_found' | 'wrong_plugin' };

// Consumes the pending record on success (or on it having expired) so a
// duplicate/late callback for the same requestId cleanly gets "not_found".
// Does NOT consume it on a plugin-id mismatch — that's rejected as a
// (likely buggy or malicious) caller, not treated as this request being done.
export function resolvePending(requestId: string, pluginId: string): ResolveResult {
  const entry = byRequestId.get(requestId);
  if (!entry) return { ok: false, reason: 'not_found' };

  if (Date.now() > entry.expiresAt) {
    removeEntry(entry);
    return { ok: false, reason: 'not_found' };
  }

  if (entry.pluginId !== pluginId) {
    return { ok: false, reason: 'wrong_plugin' };
  }

  removeEntry(entry);
  return { ok: true, chatJid: entry.chatJid };
}

function sweepExpired(): void {
  const now = Date.now();
  for (const entry of byRequestId.values()) {
    if (now > entry.expiresAt) removeEntry(entry);
  }
}

export function startPendingRepliesSweep(): NodeJS.Timeout {
  return setInterval(sweepExpired, SWEEP_INTERVAL_MS);
}
