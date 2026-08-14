---
name: create-whatsapp-plugin
description: Build a plugin for a WhatsApp agent service (local in-process TypeScript module if working inside that agent's own repo, or a remote out-of-process service that works from ANY repo/language) — or convert an existing project into one. Fully self-contained; does not require access to the WhatsApp agent's source repo. Use when the user asks to create/build/add a WhatsApp plugin, write a new auto-responder, or make an existing app work as a plugin for a WhatsApp agent.
user-invocable: true
---

# Create a WhatsApp Agent Plugin

A plugin attaches to a WhatsApp conversation and gets called whenever a new message arrives (the message + up to 20 prior messages of history), and can optionally send an automatic reply.

**This skill is self-contained.** Building a remote plugin does not require access to the WhatsApp agent's source repo, its file tree, or any of its code — everything needed (the full protocol, a complete runnable reference implementation) is in this document. If you're invoked from an unrelated repo, **do not ask to switch repos or refuse for lack of access** — proceed using the contract and code below. The only thing you actually need from the user is **where the main WhatsApp agent service is reachable** (see "Find the main service" below) — ask if it's not already stated.

## Pick local vs. remote

| | **Local** (in-process) | **Remote** (out-of-process) |
|---|---|---|
| What it is | A TypeScript module living inside the WhatsApp agent's own backend source | A separate project/service, any language, any repo, its own process/container |
| Reply timing | Synchronous — return the reply string directly | Async — ack fast, call back later with the reply |
| Requires | Being inside the agent's own repo, with its source code in front of you | Nothing except the main service's URL |
| Use when | You're already working directly in the agent's repo and want something simple/fast with no external calls | Any other case — a separate/existing project, another language, needs independent deploys, or calls something slow (an LLM, an API) |

**If you're not currently inside the WhatsApp agent's own repository, only the remote path is possible — go straight to that section.** Converting an existing project into a plugin is always the remote path too: you add a small HTTP contract to it, you don't rewrite it into the agent's repo.

---

## Building a LOCAL plugin (only possible from inside the agent's own repo)

This only applies if the current working directory *is* the WhatsApp agent's backend repo (look for a `Plugin` interface, a plugin registry, and an assignment store under a `plugins/` source directory — exact paths vary by deployment, so locate them rather than assuming a fixed path).

1. Find the plugin interface in that repo's source (typically alongside the other plugin files) — it looks like:
   ```ts
   export interface PluginMessage {
     id: string; chatJid: string; fromMe: boolean; sender: string;
     senderName?: string; timestamp: number; text: string;
   }
   export interface PluginContext<TConfig = unknown> {
     chatJid: string;
     message: PluginMessage;       // the triggering message — always history's last entry
     history: PluginMessage[];     // chronological oldest→newest, up to ~20 entries
     config: TConfig;              // this conversation's saved config, or undefined if no configSchema
   }
   export interface Plugin<TConfig = unknown> {
     id: string;              // stable, kebab-case, unique — the persistence key
     name: string;             // shown in the UI picker
     description: string;
     configSchema?: ZodType<TConfig>;  // optional; presence triggers a config-form UI + validation
     onMessage(ctx: PluginContext<TConfig>): Promise<string | void> | string | void;
   }
   ```
   Return a non-empty string to auto-reply; return `undefined`/`void`/whitespace to send nothing.

2. Write a new module exporting one `Plugin` object, following the simplest existing plugin in that repo as a template if one exists.

3. Register it in the static plugin registry (one import + one array entry) — everything else (assignment storage, REST routes, the UI picker/config-form) should already handle any `Plugin` generically; check the registry file to confirm before assuming you need to touch anything else.

Keep `onMessage` fast — it runs in-process alongside message storage and the live connection; there's no separate timeout/ack mechanism like the remote path has. Don't let it throw uncaught.

---

## Building or converting to a REMOTE plugin (works from any repo, any language)

### Find the main service

You need the base URL of a running instance of the WhatsApp agent to register against (`MAIN_SERVICE_URL`) — there is no discovery mechanism, and it is not necessarily related to the repo you're currently in. **Ask the user** if it isn't already given. Common answers: a local dev instance (`http://localhost:3000`), or a deployed instance reachable by hostname/IP — if the plugin will run in Docker alongside the main service, it's usually a Docker container/service name instead (see "Reaching the main service over the network" below).

### The contract

Every plugin↔main call in both directions carries a header `X-Plugin-Secret: <secret>`. Main can't force a third-party process to check it, but you should verify it on your `/on-message` endpoint as a defense against a spoofed caller.

**1. You → Main: register on startup — `POST {MAIN_SERVICE_URL}/plugins/register`**
```json
{ "pluginId": "your-unique-id", "name": "Display name", "description": "Shown under the name in the picker", "baseUrl": "http://your-host:PORT", "configJsonSchema": { "...optional JSON Schema..." } }
```
- New `pluginId` (no `X-Plugin-Secret` header sent) → `201 { pluginId, secret, registeredAt }`. **The secret is returned exactly once, here — persist it** (a local file is fine). `pluginId` colliding with a built-in local plugin id → `400`.
- Re-registering an existing `pluginId` (e.g. after your process restarts) → send the **same** secret back via `X-Plugin-Secret`. Matches → `200`, fields updated, same secret returned. Wrong/missing secret for an id that's taken → `409 { "error": "pluginId already registered" }`.

**2. Main → You: `POST {your baseUrl}/on-message`** (fixed path, not configurable)
```json
{ "requestId": "uuid", "chatJid": "...", "message": { "id", "chatJid", "fromMe", "sender", "senderName?", "timestamp", "text" }, "history": [ "...up to ~20 of the above, oldest first, message is the last entry..." ], "config": { "...whatever was saved via your config form..." } }
```
**Respond fast** — main only waits a few seconds (default ~5000ms) for any 2xx; the response body is ignored either way. Do your real work *after* acking (ack synchronously/immediately, process async — see the reference implementation below). If you don't answer in time, main logs it and moves on; nothing else happens automatically.

**3. You → Main: reply whenever ready — `POST {MAIN_SERVICE_URL}/plugins/callback`**
```json
{ "pluginId": "your-unique-id", "requestId": "the same uuid from step 2", "chatJid": "...", "reply": "text to send" }
```
- `200 { ok: true }` — sent for real.
- `410` — `requestId` is unknown, already used, **expired** (dropped after a TTL, default ~15 min — don't answer something that old), or **superseded** (a newer message arrived in that same chat before you replied to the older one — only the newest pending request per chat is ever honored). Treat as non-fatal, just drop it.
- `401` — bad `pluginId`/secret. `403` — this `requestId` doesn't belong to the plugin identified by your secret.
- If you have nothing to say, just don't call this at all for that `requestId`.

**4. You → Main (recommended): `POST {MAIN_SERVICE_URL}/plugins/heartbeat`**
```json
{ "pluginId": "your-unique-id" }
```
Every ~30s. Drives a health/last-seen indicator on the main service's side. Nothing auto-removes your registration for going stale — purely cosmetic for the admin.

**5. You → Main (recommended): `DELETE {MAIN_SERVICE_URL}/plugins/register`**
```json
{ "pluginId": "your-unique-id" }
```
From a shutdown handler (e.g. `SIGTERM`). If skipped, your registration just goes stale/unhealthy rather than erroring.

### Config schema rules

`configJsonSchema` (if you declare one) is rendered as a **generic auto-built form** on the main service's side — you never send HTML/JS, only a schema. Assume the renderer only understands **flat, top-level fields** of these types (this is the lowest common denominator; a specific deployment may support more, but design for this to be safe):
- `"type": "boolean"` → checkbox
- a property with an `enum` array → dropdown
- `"type": "number"` or `"integer"` → number input
- anything else (default, including `"type": "string"`) → text input

No nested objects/arrays, no `oneOf`/`anyOf`/conditional schemas — keep it flat. Each property's `description` typically becomes the field's label. Submitted config is validated server-side against your schema before saving; a plugin with no `configJsonSchema` gets `config: undefined` on every dispatch.

### Complete reference implementation (Node.js, no build step)

This is a full, working plugin — a keyword auto-responder — implementing the entire contract above. Copy it as your starting point regardless of what repo you're in; adapt the logic in `handleMessage` to whatever your plugin should actually do.

`package.json`:
```json
{
  "name": "my-whatsapp-plugin",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node index.js" },
  "dependencies": { "express": "^4.19.2" }
}
```

`index.js`:
```js
const express = require('express');
const fs = require('fs');

// Node does NOT auto-load .env files — this reads one from cwd if present,
// without adding a dotenv dependency. Existing process.env values win.
function loadDotEnv(path) {
  let content;
  try { content = fs.readFileSync(path, 'utf8'); } catch { return; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv('./.env');

const MAIN_SERVICE_URL = process.env.MAIN_SERVICE_URL; // e.g. http://localhost:3000
const PLUGIN_ID = process.env.PLUGIN_ID || 'my-keyword-responder';
const PLUGIN_BASE_URL = process.env.PLUGIN_BASE_URL;    // e.g. http://localhost:4000 (must be reachable BY the main service)
const PORT = Number(process.env.PORT) || 4000;
const SECRET_FILE = './secret.json';
const HEARTBEAT_INTERVAL_MS = 30_000;
const REGISTER_RETRY_INTERVAL_MS = 10_000;

if (!MAIN_SERVICE_URL || !PLUGIN_BASE_URL) {
  console.error('MAIN_SERVICE_URL and PLUGIN_BASE_URL are required env vars.');
  process.exit(1);
}

// What this plugin needs configured per conversation — rendered as a generic
// form by the main service's UI (see "Config schema rules" above).
const CONFIG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    keyword: { type: 'string', minLength: 1, description: 'Word/phrase to watch for (case-insensitive)' },
    reply: { type: 'string', minLength: 1, description: 'Message to send back when found' },
  },
  required: ['keyword', 'reply'],
  additionalProperties: false,
};

function loadSecret() {
  try { return JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')).secret; } catch { return undefined; }
}
function saveSecret(secret) {
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret }));
}

let secret = loadSecret();

async function registerWithMain() {
  try {
    const res = await fetch(`${MAIN_SERVICE_URL}/plugins/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Plugin-Secret': secret } : {}) },
      body: JSON.stringify({
        pluginId: PLUGIN_ID,
        name: 'My Keyword Responder',
        description: 'Replies with a fixed message when a keyword is found.',
        baseUrl: PLUGIN_BASE_URL,
        configJsonSchema: CONFIG_JSON_SCHEMA,
      }),
    });
    if (!res.ok) {
      console.error(`[register] failed (${res.status}):`, await res.json().catch(() => ({})));
      setTimeout(registerWithMain, REGISTER_RETRY_INTERVAL_MS);
      return;
    }
    const body = await res.json();
    secret = body.secret;
    saveSecret(secret);
    console.log(`[register] registered as "${PLUGIN_ID}" with ${MAIN_SERVICE_URL}`);
    setInterval(async () => {
      try {
        await fetch(`${MAIN_SERVICE_URL}/plugins/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret },
          body: JSON.stringify({ pluginId: PLUGIN_ID }),
        });
      } catch (err) { console.error('[heartbeat] failed:', err.message); }
    }, HEARTBEAT_INTERVAL_MS);
  } catch (err) {
    console.error('[register] main service unreachable, retrying shortly:', err.message);
    setTimeout(registerWithMain, REGISTER_RETRY_INTERVAL_MS);
  }
}

// --- Your plugin's actual logic goes here ---
async function handleMessage({ requestId, chatJid, message, config }) {
  if (!message.text.toLowerCase().includes(config.keyword.toLowerCase())) return;

  // Do whatever real work you need here (call an LLM, hit an API, etc).
  // This artificial delay just illustrates that it's fine to take time —
  // that's the whole point of the async contract.
  await new Promise((r) => setTimeout(r, 500));

  try {
    const res = await fetch(`${MAIN_SERVICE_URL}/plugins/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret },
      body: JSON.stringify({ pluginId: PLUGIN_ID, requestId, chatJid, reply: config.reply }),
    });
    if (!res.ok) console.error(`[callback] rejected (${res.status}) for ${requestId} — likely expired/superseded, dropping.`);
  } catch (err) {
    console.error('[callback] failed to reach main service:', err.message);
  }
}

const app = express();
app.use(express.json());

app.post('/on-message', (req, res) => {
  if (req.header('X-Plugin-Secret') !== secret) {
    res.status(401).json({ error: 'Invalid secret.' });
    return;
  }
  res.json({ ok: true }); // ack immediately — do real work after responding
  handleMessage(req.body).catch((err) => console.error('[on-message] handler threw:', err));
});

app.listen(PORT, () => {
  console.log(`Plugin listening on port ${PORT}`);
  registerWithMain();
});

async function shutdown() {
  try {
    await fetch(`${MAIN_SERVICE_URL}/plugins/register`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret || '' },
      body: JSON.stringify({ pluginId: PLUGIN_ID }),
    });
  } catch (err) { console.error('[shutdown] unregister failed:', err.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Also write a `.env` (or `.env.example`) alongside `package.json`/`index.js` — it's picked up automatically by the loader above, no extra install:
```
MAIN_SERVICE_URL=http://<main-service-host>:3000
PLUGIN_ID=my-keyword-responder
PLUGIN_BASE_URL=http://<this-machine's-address-as-seen-from-main>:4000
PORT=4000
```

That's the entire plugin — no build step, `npm install && node index.js` (with `.env` populated, or the same vars passed inline) runs it. Translate the same logic to any other language/framework if that's what the target project already uses; the HTTP contract is language-agnostic.

### Reaching the main service over the network

**`PLUGIN_BASE_URL` is the one setting most likely to be silently wrong** — get it right up front, because the failure mode is deceptive: registration and heartbeats are calls *you* make outward to main, so they succeed and the plugin shows `healthy: true` in `GET /plugins` even when `PLUGIN_BASE_URL` is completely unreachable. The break only shows up later, on the inbound call *main* makes to *you* (`POST {baseUrl}/on-message`) — which looks from the outside like "the plugin is healthy but just never replies." Don't trust a healthy registration as proof the wiring works; only an actual end-to-end message test does (see the testing checklist).

- **Same machine, both processes running locally**: `MAIN_SERVICE_URL=http://localhost:PORT`, and `PLUGIN_BASE_URL=http://localhost:PORT` works too, since "localhost" means the same thing to both sides.
- **Different machines on the same network, run as plain processes (no Docker)**: `localhost` in `PLUGIN_BASE_URL` is wrong here — from main's perspective, `localhost` resolves to *itself*, not to your machine. Use your machine's actual LAN IP instead (find it with `ipconfig` on Windows or `ip addr`/`ifconfig` on Linux/Mac — pick the address on the same subnet as the main service's host, not a Docker/virtual adapter). E.g. if main is at `10.0.0.111:3000` and your machine is `10.0.0.60`, set `PLUGIN_BASE_URL=http://10.0.0.60:4000`. Also check the plugin's port isn't blocked by a local firewall for inbound connections from the main service's host.
- **Both in Docker, on the same host**: they need a shared Docker network. If the main service already has one it expects plugins to join (check its own deployment docs/compose file if you have access to them), join that; otherwise agree on/create one (`docker network create <name>`, both compose files reference it as `external: true`, each service gets a `container_name` so the other can reach it by that name — e.g. `MAIN_SERVICE_URL=http://<main-container-name>:PORT`). Don't publish your plugin's port to the host; only the main service needs to reach it.
- **Deployed/remote main service**: use whatever URL/hostname is actually reachable — ask the user if unclear.

### Testing checklist

1. Confirm `MAIN_SERVICE_URL` is correct and the main service is actually reachable from wherever your plugin runs (`curl {MAIN_SERVICE_URL}/plugins` as a sanity check if you can).
2. Start your plugin — check its logs for a successful registration (no repeated retry/error loop).
3. `GET {MAIN_SERVICE_URL}/plugins` — your plugin should appear, flagged as remote. **`healthy: true` here only proves outbound calls work — it does NOT prove `PLUGIN_BASE_URL` is reachable.** Don't stop here.
4. On the main service's side, attach your plugin to a conversation — your config form should render correctly from your schema; invalid config should be rejected with a clear error, valid config should save.
5. Send a real message that should trigger a reply. Watch your plugin's logs for the `/on-message` hit — this is the real test of `PLUGIN_BASE_URL`. If nothing shows up in the plugin's logs at all (not even a rejected/failed attempt), that's the "healthy but unreachable" `PLUGIN_BASE_URL` failure mode above, not a bug in your `handleMessage` logic. Then confirm the reply actually lands as a real outgoing message.
6. Restart your plugin — confirm it re-registers using its persisted secret (no `409`).

### Common pitfalls

- **Slow ack** — don't do real work before responding to `/on-message`; you only get a few seconds before main considers the dispatch failed.
- **`PLUGIN_BASE_URL` set to `localhost` when main is on a different machine** — the single most common cause of "registered and healthy, but never replies." See "Reaching the main service over the network" above. Registration succeeding is not evidence this is set correctly, since registration is an outbound call and doesn't exercise `baseUrl` at all.
- **Losing the secret** — persist it across your own restarts (a local file, a mounted volume, whatever fits) or you'll get `409` re-registering. This includes deleting/wiping the secret file right after a one-off test registration succeeded — that leaves an orphaned registration under that `pluginId` on main that you can no longer update or delete (both require the secret you just lost). If that happens, don't fight it: just pick a new `pluginId` and re-register fresh: the old entry is inert and harmless, just leave it.
- **Replying to a superseded/expired request** — expect occasional `410`s if you're slow; that's by design, not a bug.
- **Reserved/colliding plugin ids** — pick something unique; a `400` on register means the id is taken by a built-in local plugin.
- **Complex config schemas** — keep them flat; nested structures may not render.

---

## If you happen to be working inside the WhatsApp agent's own repo

Everything above is sufficient on its own, but if the current repo *is* the agent itself, you likely have extra material to cross-check against or reuse instead of writing from scratch: a static plugin registry file, the exact route handlers implementing this contract (authoritative over this document if they ever disagree — implementations can drift from docs), and possibly an existing example/reference plugin project already living in the repo. Look for these rather than assuming fixed paths — project layout can change over time; this document intentionally doesn't hard-code them.
