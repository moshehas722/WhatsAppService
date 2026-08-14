# WhatsApp Agent

Connects to WhatsApp Web via Baileys, exposes a REST API and MCP server, and serves a small web UI for sending/reading messages and managing conversation plugins.

- `backend/` — the Node/TypeScript service (Express + Baileys + MCP).
- `frontend/` — the static web UI, served by the backend.
- `deploy/docker/` — Dockerfile + Compose file for the main service.
- `examples/remote-plugin-template/` — a reference implementation of an out-of-process plugin (see below).

## Running locally

```
cd backend
npm install
cp ../.env.example ../.env
npm run dev
```

Open `http://localhost:3000/`, scan the QR code, done. See `.env.example` for available settings.

## Plugins

A conversation can have a **plugin** attached: whenever a new message arrives, the plugin gets the message plus recent history, and can send an automatic reply. Plugins come in two flavors:

**Local (in-process)** — a TypeScript module built into this repo (`backend/src/plugins/*`), registered in a static list. Simple, zero-setup, but adding one means editing this codebase and redeploying.

**Remote (out-of-process)** — an entirely separate project, running as its own Docker container, that registers itself with the running service over the network. Adding or removing one is just starting/stopping that project's own `docker compose` — no changes here required.

### Running a remote plugin

1. One-time setup, shared by every plugin project on this machine:
   ```
   docker network create whatapp-agent-net
   ```
2. Bring up the main service (`deploy/docker/docker-compose.yml` already joins this network).
3. Bring up a plugin project (see `examples/remote-plugin-template/` for a full working example and its own README documenting the contract) — it registers itself automatically on startup.
4. It shows up in the plugin picker in the UI, same as a local one.

### The remote plugin contract, in brief

A plugin is any HTTP server that:
1. `POST`s to the main service's `/plugins/register` on startup (gets back a secret; must persist it and re-present it on future registrations).
2. Implements `POST /on-message` at the URL it registered — receives the triggering message + history + saved config, acks fast (~5s), and does any real work *after* acking.
3. `POST`s to `/plugins/callback` whenever it has a reply — this can happen seconds or minutes later; the reply is dropped (not sent) if the request has since expired (~15 min) or been superseded by a newer message in that chat.
4. Optionally sends a heartbeat (`POST /plugins/heartbeat`) so the UI can show it as healthy, and unregisters (`DELETE /plugins/register`) on shutdown.

Every call in both directions carries an `X-Plugin-Secret` header. See `examples/remote-plugin-template/README.md` for the full request/response shapes and a working reference implementation.

Config is declared as a JSON Schema (validated server-side before saving) and rendered as a generic form in the UI — plugins don't own or serve any of their own UI.
