import fs from 'fs';
import path from 'path';
import { getAlias } from '../jidAliases';

export interface PluginAssignment {
  chatJid: string;
  pluginId: string;
  config: unknown;
  enabled: boolean;
  updatedAt: number;
}

const ASSIGNMENTS_PATH = path.join(process.cwd(), 'auth_info', 'plugin-assignments.json');

const assignments = new Map<string, PluginAssignment>();

// Call once at startup so assignments survive a restart.
export function loadPersistedPluginAssignments(): void {
  if (!fs.existsSync(ASSIGNMENTS_PATH)) return;
  try {
    const saved: Record<string, PluginAssignment> = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
    for (const [chatJid, assignment] of Object.entries(saved)) {
      // `enabled` was added after this file format shipped — default to true
      // for assignments persisted before that so they keep working.
      assignments.set(chatJid, { ...assignment, enabled: assignment.enabled ?? true });
    }
    console.error(`[plugins] loaded ${assignments.size} plugin assignment(s) from disk`);
  } catch (err) {
    console.error('[plugins] failed to load plugin assignments:', err);
  }
}

// Assignment writes are rare, explicit, user-initiated actions (not a
// high-volume network-driven stream like messages), so write through to disk
// immediately rather than batching — the user expects "Save" to be durable.
function persist(): void {
  try {
    fs.mkdirSync(path.dirname(ASSIGNMENTS_PATH), { recursive: true });
    fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(Object.fromEntries(assignments)));
  } catch (err) {
    console.error('[plugins] failed to persist plugin assignments:', err);
  }
}

// WhatsApp can re-address the same real conversation under a different JID
// over time (see ../jidAliases.ts — @lid vs phone-number identity). If the
// exact chatJid has no assignment but its known alias does, treat the alias
// as where the record actually lives, so a plugin doesn't appear to vanish
// when that switch happens.
function effectiveKey(chatJid: string): string {
  if (assignments.has(chatJid)) return chatJid;
  const alias = getAlias(chatJid);
  if (alias && assignments.has(alias)) return alias;
  return chatJid;
}

export function getPluginAssignment(chatJid: string): PluginAssignment | undefined {
  return assignments.get(effectiveKey(chatJid));
}

export function listPluginAssignments(): PluginAssignment[] {
  return [...assignments.values()];
}

// Assigning (or re-saving) a plugin always (re)activates it — a fresh Save
// from the picker is an explicit "use this plugin now" action. Routed
// through effectiveKey so re-saving via a chat's new JID form updates the
// existing record (wherever it lives) instead of creating a duplicate.
export function setPluginAssignment(chatJid: string, pluginId: string, config: unknown): void {
  const key = effectiveKey(chatJid);
  assignments.set(key, { chatJid: key, pluginId, config, enabled: true, updatedAt: Math.floor(Date.now() / 1000) });
  persist();
}

// Returns false if there's no assignment for this chat to toggle.
export function setAssignmentEnabled(chatJid: string, enabled: boolean): boolean {
  const key = effectiveKey(chatJid);
  const existing = assignments.get(key);
  if (!existing) return false;
  assignments.set(key, { ...existing, enabled, updatedAt: Math.floor(Date.now() / 1000) });
  persist();
  return true;
}

export function clearPluginAssignment(chatJid: string): void {
  if (assignments.delete(effectiveKey(chatJid))) {
    persist();
  }
}
