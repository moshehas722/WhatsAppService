# Remote plugin template

A working reference implementation of an out-of-process plugin for the WhatsApp agent — a keyword auto-responder, functionally identical to the app's built-in local one, but running as its own independent Docker service. Use this as a starting point for writing your own plugin in any language.

## Running it

1. One-time setup (only needs doing once, shared by every plugin project): `docker network create whatapp-agent-net`, and have the main `whatapp-agent` service already running and joined to that same network (see the main repo's `deploy/docker/docker-compose.yml`).
2. From this directory: `docker compose up --build -d`.
3. It registers itself with the main service on startup — check its logs for `[register] registered as "example-keyword-responder-remote"`.
4. In the main app's UI, open a conversation, click the plugin picker — you should see "Keyword Auto-Responder (remote example)" alongside the built-in one. Attach it, set a keyword/reply, and message that chat.

## The contract, from a plugin author's point of view

Your plugin is any HTTP server, in any language, that:

### 1. Registers itself on startup

`POST {MAIN_SERVICE_URL}/plugins/register`
```json
{ "pluginId": "your-unique-id", "name": "Display name", "description": "Shown under the name in the picker", "baseUrl": "http://your-container:PORT", "configJsonSchema": { "...": "optional JSON Schema" } }
```
- First time: main generates a **secret** and returns it in the response (`{ pluginId, secret, registeredAt }`) — **exactly once**. Persist it somewhere durable (this template writes it to `./data/secret.json`, bind-mounted so it survives a container restart).
- Every subsequent registration (e.g. after your container restarts): send the **same** secret back via the `X-Plugin-Secret` header. Main updates your registration and returns the same secret. If you send the wrong secret (or none, for an id that's already taken), you get `409`.
- `configJsonSchema`, if provided, drives a generic auto-rendered config form in the main app's UI (text/number/boolean/enum fields only — no custom UI). If your plugin needs no per-conversation config, omit it.

### 2. Implements `POST /on-message` at whatever `baseUrl` you registered

Main calls this whenever a live message arrives in a conversation you're attached to:
```json
{ "requestId": "uuid", "chatJid": "...", "message": { "id", "chatJid", "fromMe", "sender", "senderName?", "timestamp", "text" }, "history": [ /* up to 20 of the above, oldest first, message is the last entry */ ], "config": { /* whatever you saved via the config form */ } }
```
**Respond fast** — main only waits ~5 seconds for any 2xx response (the body is ignored) before considering the dispatch failed and moving on. Don't do slow work before responding: ack immediately, then do your real work (this template acks synchronously, then processes async — see `src/index.ts`).

You'll receive `X-Plugin-Secret` on this request too — verify it matches what you were issued, though note main can't force you to; it's your own defense against a spoofed caller on the shared network.

### 3. Calls back when it has a reply — whenever it's ready

`POST {MAIN_SERVICE_URL}/plugins/callback`
```json
{ "pluginId": "your-unique-id", "requestId": "the same uuid from step 2", "chatJid": "...", "reply": "text to send" }
```
Header: `X-Plugin-Secret`. If nothing should be sent, just don't call this at all for that `requestId`.

Possible responses:
- `200` — sent.
- `410` — the `requestId` is unknown, already used, **expired** (pending requests are dropped after ~15 minutes — don't reply to something that old), or **superseded** (a newer message arrived in that chat before you replied to the older one; only the newest pending request per chat is ever honored). Treat this as non-fatal — just drop it.
- `401`/`403` — bad secret, or this `requestId` doesn't belong to you.

### 4. Sends a heartbeat periodically (recommended, not required)

`POST {MAIN_SERVICE_URL}/plugins/heartbeat` with `{ "pluginId": "..." }` + `X-Plugin-Secret`, every 30s or so. Drives a health/last-seen indicator in the main app's UI. Nothing ever auto-removes your registration for going stale — this is purely cosmetic for the admin.

### 5. Unregisters on shutdown (recommended, not required)

`DELETE {MAIN_SERVICE_URL}/plugins/register` with `{ "pluginId": "..." }` + `X-Plugin-Secret`, e.g. from a `SIGTERM` handler. If you skip this, your registration just goes stale (shows unhealthy in the UI) rather than causing any error.

## Environment variables this template reads

| Var | Meaning |
|---|---|
| `MAIN_SERVICE_URL` | Where to reach the main service, e.g. `http://whatapp-agent:3000` (its Docker container name on the shared network) |
| `PLUGIN_ID` | Your chosen unique id |
| `PLUGIN_BASE_URL` | The URL main should use to reach *you*, e.g. `http://plugin-keyword-example:4000` |
| `PORT` | What port this server listens on internally |

## Trust/security notes

- All of this runs over plain HTTP on the shared internal Docker network — there's no TLS between main and plugins, and the network itself is the trust boundary.
- Main issues your secret; guard it like a credential. It's stored in plaintext both in this template's `data/secret.json` and in main's own `plugin-registrations.json` — consistent with how the rest of the main app stores its local state, but worth knowing.
