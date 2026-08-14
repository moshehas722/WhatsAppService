---
name: create-whatsapp-plugin
description: Build a new plugin for this WhatsApp agent (local in-process TypeScript module, or remote out-of-process service) or convert an existing project/service into a remote plugin. Use when the user asks to create/build/add a plugin, write a new auto-responder, or make an existing app work as a plugin for this WhatsApp agent.
user-invocable: true
---

# Create a WhatsApp Agent Plugin

A plugin attaches to a conversation and gets called whenever a new message arrives (the message + up to 20 prior messages of history), and can optionally send an automatic reply. There are two ways to build one — decide which before writing anything.

## Pick local vs. remote

| | **Local** (in-process) | **Remote** (out-of-process) |
|---|---|---|
| What it is | A TypeScript module inside `backend/src/plugins/` | A separate project/service, any language, its own Docker container |
| Reply timing | Synchronous — return the reply string directly | Async — ack fast, call back later with the reply |
| Use when | Simple/fast logic, fine to live in this repo, no external calls | Converting an existing project, needs its own deploy lifecycle, written in another language, or calls something slow (an LLM, an API) |
| Deploy | Ship with this repo | Independent `docker compose up`/`down`, no changes to this repo |

**Converting an existing project is always the remote path** — you add a small HTTP contract to it, you don't rewrite it into this repo.

---

## Building a LOCAL plugin

1. Create `backend/src/plugins/<yourId>.ts` exporting a `Plugin` object (see the `Plugin`/`PluginContext`/`PluginMessage` interfaces in `backend/src/plugins/types.ts`):
   ```ts
   export interface Plugin<TConfig = unknown> {
     id: string;              // stable, kebab-case, unique — used as the persistence key
     name: string;             // shown in the UI picker
     description: string;
     configSchema?: z.ZodType<TConfig>;  // optional; presence triggers a config-form UI + validation
     onMessage(ctx: PluginContext<TConfig>): Promise<string | void> | string | void;
   }
   ```
   `ctx` gives you `chatJid`, `message` (the triggering `PluginMessage`), `history` (chronological, oldest→newest, includes `message` as the last entry), and `config` (this conversation's saved config, or `undefined` if you declared no `configSchema`).

   Return a non-empty string to auto-reply; return `undefined`/`void`/whitespace to send nothing.

2. Register it in `backend/src/plugins/registry.ts`'s `staticPlugins` array (one import + one array entry). Nothing else needs to change — `assignmentStore.ts`, `manager.ts`, the REST routes, and the frontend picker/config-form all already handle any `Plugin`, local or remote, generically.

3. Copy the pattern from `backend/src/plugins/keywordResponder.ts` — it's a complete, working, minimal example (zod config schema with two string fields, substring match, done in ~20 lines).

Keep `onMessage` fast — it runs in-process on the same event loop as message storage and the Baileys connection; there's no separate timeout/ack mechanism like the remote path has. A thrown error is caught defensively by `manager.runAssignedPlugin`, but don't rely on that — just don't throw.

---

## Building or converting to a REMOTE plugin

Fastest path: copy `examples/remote-plugin-template/` as your starting point — it's a complete, working reference plugin (keyword auto-responder) implementing every part of this contract, plus its own README documenting it from a plugin author's point of view. Read that README too; this file and it should agree — if they ever don't, trust the actual source files listed at the bottom of this doc over either doc.

**Converting an existing project**: don't rewrite it. Just add to it:
- An `/on-message` HTTP endpoint (any framework, any language)
- A small startup registration call
- A callback function it calls when it has a reply
- Docker Compose wiring to join the shared network

None of that requires touching the project's existing routes/logic.

### The contract

Every plugin↔main call in both directions carries a header `X-Plugin-Secret: <secret>`. Main can't force a third-party process to check it, but you should verify it on your `/on-message` endpoint as a defense against a spoofed caller on the shared network.

**1. You → Main: register on startup — `POST {MAIN_SERVICE_URL}/plugins/register`**
```json
{ "pluginId": "your-unique-id", "name": "Display name", "description": "Shown under the name in the picker", "baseUrl": "http://your-container:PORT", "configJsonSchema": { "...optional JSON Schema..." } }
```
- New `pluginId` (no `X-Plugin-Secret` header sent) → `201 { pluginId, secret, registeredAt }`. **The secret is returned exactly once, here — persist it** (e.g. to a file on a mounted volume). `pluginId` colliding with a built-in local plugin (currently `keyword-responder`) → `400`.
- Re-registering an existing `pluginId` (e.g. after your container restarts) → send the **same** secret back via `X-Plugin-Secret`. Matches → `200`, fields updated, same secret returned. Wrong/missing secret for an id that's taken → `409 { "error": "pluginId already registered" }`.

**2. Main → You: `POST {your baseUrl}/on-message`** (fixed path, not configurable)
```json
{ "requestId": "uuid", "chatJid": "...", "message": { "id", "chatJid", "fromMe", "sender", "senderName?", "timestamp", "text" }, "history": [ "...up to 20 of the above, oldest first, message is the last entry..." ], "config": { "...whatever was saved via your config form..." } }
```
**Respond fast.** Main only waits `PLUGIN_ACK_TIMEOUT_MS` (default 5000ms) for any 2xx — the response body is ignored either way. Do your real work *after* acking (ack synchronously, process async — see the template). If you don't answer in time, main logs it and moves on; nothing else happens automatically.

**3. You → Main: reply whenever ready — `POST {MAIN_SERVICE_URL}/plugins/callback`**
```json
{ "pluginId": "your-unique-id", "requestId": "the same uuid from step 2", "chatJid": "...", "reply": "text to send" }
```
- `200 { ok: true }` — sent for real.
- `410` — `requestId` is unknown, already used, **expired** (dropped after `PLUGIN_PENDING_REPLY_TTL_MS`, default 15 min — don't answer something that old), or **superseded** (a newer message arrived in that same chat before you replied to the older one — only the newest pending request per chat is ever honored). Treat as non-fatal, just drop it.
- `401` — bad `pluginId`/secret. `403` — this `requestId` doesn't belong to the plugin identified by your secret.
- If you have nothing to say, just don't call this at all for that `requestId`.

**4. You → Main (recommended): `POST {MAIN_SERVICE_URL}/plugins/heartbeat`**
```json
{ "pluginId": "your-unique-id" }
```
Every ~30s. Drives a health/last-seen badge in the UI (`healthy` = seen within `PLUGIN_HEARTBEAT_STALE_MS`, default 90s). Nothing auto-removes your registration for going stale — purely cosmetic for the admin.

**5. You → Main (recommended): `DELETE {MAIN_SERVICE_URL}/plugins/register`**
```json
{ "pluginId": "your-unique-id" }
```
From a `SIGTERM` handler. If skipped, your registration just goes stale/unhealthy rather than erroring.

### Docker networking

One-time, shared by every plugin project on the machine:
```
docker network create whatapp-agent-net
```
The main service (`deploy/docker/docker-compose.yml`) has `container_name: whatapp-agent` and joins this network — that container name is how plugins reach it (`http://whatapp-agent:3000`), not `localhost` and not the host-published ports. Your plugin's own `docker-compose.yml` should:
```yaml
services:
  your-plugin:
    build: .
    container_name: your-plugin      # main reaches you at http://your-plugin:PORT
    environment:
      MAIN_SERVICE_URL: http://whatapp-agent:3000
      PLUGIN_ID: your-unique-id
      PLUGIN_BASE_URL: http://your-plugin:PORT
    networks:
      - whatapp-agent-net
networks:
  whatapp-agent-net:
    external: true
```
Don't publish your plugin's port to the host — only the main service needs to reach it, over the internal network. See `examples/remote-plugin-template/docker-compose.yml` for the exact working version.

### Config schema rules

`configJsonSchema` (if you declare one) is rendered as a **generic auto-built form** in the main app's UI — you never send HTML/JS, only a schema. The renderer (`frontend/index.html`'s `fieldInputForSchema`) only understands **flat, top-level fields** of these types:
- `"type": "boolean"` → checkbox
- a property with an `enum` array (any declared type) → `<select>` dropdown
- `"type": "number"` or `"integer"` → number input
- anything else (default, including `"type": "string"`) → text input

No nested objects/arrays, no `oneOf`/`anyOf`/conditional schemas, no custom widgets — keep your schema flat. Each property's `description` becomes the field's label in the UI. Submitted config is validated server-side against your schema with `ajv` before saving; a plugin with no `configJsonSchema` gets `config: undefined` on every dispatch.

### Testing checklist

1. `docker network create whatapp-agent-net` (skip if it already exists) and confirm the main service is up and joined to it.
2. Bring up your plugin (`docker compose up --build -d` from its own project) — check its logs for a successful `[register]`-style confirmation.
3. `GET {MAIN_SERVICE_URL}/plugins` — your plugin should appear with `"remote": true`.
4. `GET {MAIN_SERVICE_URL}/plugins/registrations` — sanity-check `baseUrl`/`configJsonSchema` look right (never includes the secret).
5. In the UI, attach your plugin to a conversation — your config form should render correctly from your schema; save should succeed for valid config and give a clear ajv error for invalid config.
6. Send a real message containing whatever should trigger a reply. Watch your plugin's logs for the `/on-message` hit, then confirm the reply actually lands (both in your plugin's callback logs and as a real message in the conversation).
7. Restart your plugin container — confirm it re-registers using its persisted secret (no `409`), and the health badge recovers after its next heartbeat.

### Common pitfalls

- **Slow ack** — don't do real work before responding to `/on-message`; you only get ~5s before main considers the dispatch failed (it still delivers your later callback if you eventually call back within the TTL, but the plugin shows as having failed the dispatch in logs).
- **Losing the secret** — if you don't persist it across your own restarts, you'll get `409` trying to re-register. Store it somewhere durable (a bind-mounted file, like the template does).
- **Replying to a superseded/expired request** — expect occasional `410`s if you're slow; that's by design, not a bug to work around.
- **Reserved id** — `keyword-responder` (the built-in local plugin) can't be used as your `pluginId`.
- **Publishing your port to the host** — unnecessary and shouldn't be done; main only needs the internal Docker network.
- **Nested/complex config schemas** — will render badly or not at all in the UI form; keep it flat.

### Reference files in this repo

- `backend/src/plugins/types.ts` — the `Plugin`/`PluginContext`/`PluginMessage`/`PluginSummary` interfaces
- `backend/src/plugins/registry.ts` — how local (static) and remote (dynamic) plugins merge
- `backend/src/plugins/keywordResponder.ts` — minimal working local plugin
- `backend/src/routes/pluginRegistration.ts`, `backend/src/routes/pluginCallback.ts` — the exact server-side contract implementation (authoritative over this doc if they ever disagree)
- `backend/src/plugins/remotePlugin.ts` — how main dispatches to a remote plugin (ack timeout, always-undefined return)
- `backend/src/plugins/pendingReplies.ts` — TTL/supersede/correlation logic
- `backend/src/plugins/configSchema.ts` — zod (local) vs ajv (remote) config validation
- `examples/remote-plugin-template/` — full working reference remote plugin, plus its own README
- Root `README.md` — short quickstart summary of all of the above
