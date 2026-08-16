import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface RemotePluginRegistration {
  pluginId: string;
  name: string;
  description: string;
  baseUrl: string;
  configJsonSchema?: object;
  secret: string;
  registeredAt: number;
  updatedAt: number;
  lastSeenAt?: number;
}

export interface RemotePluginFields {
  name: string;
  description: string;
  baseUrl: string;
  configJsonSchema?: object;
}

const REGISTRATIONS_PATH = path.join(process.cwd(), 'auth_info', 'plugin-registrations.json');

const registrations = new Map<string, RemotePluginRegistration>();

export function loadPersistedRemoteRegistrations(): void {
  if (!fs.existsSync(REGISTRATIONS_PATH)) return;
  try {
    const saved: Record<string, RemotePluginRegistration> = JSON.parse(fs.readFileSync(REGISTRATIONS_PATH, 'utf8'));
    for (const [pluginId, reg] of Object.entries(saved)) registrations.set(pluginId, reg);
    console.error(`[remoteRegistry] loaded ${registrations.size} plugin registration(s) from disk`);
  } catch (err) {
    console.error('[remoteRegistry] failed to load plugin registrations:', err);
  }
}

// Registrations are rare, explicit events (a plugin container starting up),
// not a high-volume stream — write through immediately, same convention as
// assignmentStore.ts.
function persist(): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRATIONS_PATH), { recursive: true });
    fs.writeFileSync(REGISTRATIONS_PATH, JSON.stringify(Object.fromEntries(registrations)));
  } catch (err) {
    console.error('[remoteRegistry] failed to persist plugin registrations:', err);
  }
}

function generateSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

export type RegisterResult = { created: boolean; secret: string } | { error: string };

// Upsert keyed by pluginId. A brand-new id gets a freshly generated secret
// (returned exactly once, here). Re-registering an existing id must present
// the matching secret — this is what lets a plugin container restart
// safely re-announce itself without colliding with its own prior state.
export function register(pluginId: string, fields: RemotePluginFields, presentedSecret?: string): RegisterResult {
  const existing = registrations.get(pluginId);
  const now = Math.floor(Date.now() / 1000);

  if (!existing) {
    const secret = generateSecret();
    registrations.set(pluginId, {
      pluginId,
      ...fields,
      secret,
      registeredAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
    persist();
    return { created: true, secret };
  }

  if (existing.secret !== presentedSecret) {
    return { error: 'pluginId already registered' };
  }

  registrations.set(pluginId, { ...existing, ...fields, updatedAt: now, lastSeenAt: now });
  persist();
  return { created: false, secret: existing.secret };
}

export function verifySecret(pluginId: string, secret: string | undefined): boolean {
  if (!secret) return false;
  return registrations.get(pluginId)?.secret === secret;
}

export function get(pluginId: string): RemotePluginRegistration | undefined {
  return registrations.get(pluginId);
}

export function list(): RemotePluginRegistration[] {
  return [...registrations.values()];
}

// Heartbeats can be frequent; unlike the rest of this store, deliberately
// NOT persisted per-call — losing the very latest lastSeenAt on an unclean
// restart is harmless, it's rebuilt within one heartbeat interval.
export function touchLastSeen(pluginId: string): boolean {
  const existing = registrations.get(pluginId);
  if (!existing) return false;
  existing.lastSeenAt = Math.floor(Date.now() / 1000);
  return true;
}

export function unregister(pluginId: string, secret: string): boolean {
  if (!verifySecret(pluginId, secret)) return false;
  registrations.delete(pluginId);
  persist();
  return true;
}

// Admin-initiated removal (e.g. from the management UI) — unlike unregister(),
// doesn't require the plugin's own secret, since this is a local-admin action
// rather than the plugin self-deregistering. Conversation assignments that
// referenced this pluginId are left as-is; they already degrade gracefully
// (see manager.getAssignment's pluginFound flag) rather than needing a cascade.
export function adminRemove(pluginId: string): boolean {
  if (!registrations.has(pluginId)) return false;
  registrations.delete(pluginId);
  persist();
  return true;
}

const HEARTBEAT_STALE_MS = Number(process.env.PLUGIN_HEARTBEAT_STALE_MS) || 90_000;

export function isHealthy(registration: RemotePluginRegistration): boolean {
  if (!registration.lastSeenAt) return false;
  return Date.now() - registration.lastSeenAt * 1000 < HEARTBEAT_STALE_MS;
}
