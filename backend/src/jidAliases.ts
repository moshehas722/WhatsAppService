import fs from 'fs';
import path from 'path';

const ALIASES_PATH = path.join(process.cwd(), 'auth_info', 'jid-aliases.json');

// WhatsApp can address the same real contact under two different JIDs: a
// privacy-preserving "@lid" identifier, and their phone-number-based
// "@s.whatsapp.net" JID. Which one a given chat uses can change over time as
// identity resolves (e.g. once a phone number is shared/discovered) — this
// map records observed lid<->phone-number pairs (both directions, so lookup
// works either way) so the rest of the app can recognize "this is the same
// conversation" across that switch.
const aliases = new Map<string, string>();

export function loadPersistedJidAliases(): void {
  if (!fs.existsSync(ALIASES_PATH)) return;
  try {
    const saved: Record<string, string> = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    for (const [jid, alias] of Object.entries(saved)) aliases.set(jid, alias);
    console.error(`[jidAliases] loaded ${aliases.size} alias entr(ies) from disk`);
  } catch (err) {
    console.error('[jidAliases] failed to load jid aliases:', err);
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(ALIASES_PATH), { recursive: true });
    fs.writeFileSync(ALIASES_PATH, JSON.stringify(Object.fromEntries(aliases)));
  } catch (err) {
    console.error('[jidAliases] failed to persist jid aliases:', err);
  }
}

// Alias events are rare (identity resolution, not per-message), so write
// through to disk immediately rather than batching.
export function recordAlias(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === b) return false;
  let changed = false;
  if (aliases.get(a) !== b) {
    aliases.set(a, b);
    changed = true;
  }
  if (aliases.get(b) !== a) {
    aliases.set(b, a);
    changed = true;
  }
  if (changed) persist();
  return changed;
}

export function getAlias(jid: string): string | undefined {
  return aliases.get(jid);
}

// Phone-number JIDs are the stable, user-facing form (what you'd search/type)
// — prefer that as the canonical identity whenever a pair includes one.
export function pickCanonicalJid(a: string, b: string): string {
  if (a.endsWith('@s.whatsapp.net')) return a;
  if (b.endsWith('@s.whatsapp.net')) return b;
  return a;
}

// Resolves a JID to its canonical form if an alias is known — safe/cheap
// no-op otherwise. Callers should route every chatJid through this before
// using it as a storage key, so conversations/contacts/plugins all
// consistently accumulate under one identity per real contact.
export function canonicalizeJid(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  const alias = aliases.get(jid);
  return alias ? pickCanonicalJid(jid, alias) : jid;
}
