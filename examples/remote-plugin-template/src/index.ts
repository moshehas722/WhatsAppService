import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';

// --- Config from env (see README.md for what each of these means) ---
const MAIN_SERVICE_URL = process.env.MAIN_SERVICE_URL ?? 'http://whatapp-agent:3000';
const PLUGIN_ID = process.env.PLUGIN_ID ?? 'example-keyword-responder-remote';
const PLUGIN_BASE_URL = process.env.PLUGIN_BASE_URL;
const PORT = Number(process.env.PORT) || 4000;
const SECRET_FILE = path.join(__dirname, '..', 'data', 'secret.json');
const HEARTBEAT_INTERVAL_MS = 30_000;
const REGISTER_RETRY_INTERVAL_MS = 10_000;

if (!PLUGIN_BASE_URL) {
  console.error('PLUGIN_BASE_URL is required — the URL the main service should use to reach this plugin container.');
  process.exit(1);
}

// This is what the plugin declares it needs configured per conversation —
// the main service turns this straight into a generic form in its UI, and
// validates submitted config against it before saving.
const CONFIG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    keyword: { type: 'string', minLength: 1, description: 'Word or phrase to watch for (case-insensitive substring match)' },
    reply: { type: 'string', minLength: 1, description: 'Message to send back when the keyword is found' },
  },
  required: ['keyword', 'reply'],
  additionalProperties: false,
};

// --- Secret persistence: main issues this at registration time; we must
// remember it across our own restarts so re-registering doesn't collide
// with our own prior registration (see README.md). ---
function loadStoredSecret(): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')).secret;
  } catch {
    return undefined;
  }
}

function saveSecret(secret: string): void {
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret }));
}

let secret: string | undefined = loadStoredSecret();

async function registerWithMain(): Promise<void> {
  try {
    const res = await fetch(`${MAIN_SERVICE_URL}/plugins/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Plugin-Secret': secret } : {}),
      },
      body: JSON.stringify({
        pluginId: PLUGIN_ID,
        name: 'Keyword Auto-Responder (remote example)',
        description: 'Reference remote plugin: replies with a fixed message when an incoming message contains a configured keyword.',
        baseUrl: PLUGIN_BASE_URL,
        configJsonSchema: CONFIG_JSON_SCHEMA,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[register] failed (${res.status}):`, body);
      setTimeout(registerWithMain, REGISTER_RETRY_INTERVAL_MS);
      return;
    }

    const body = (await res.json()) as { secret: string };
    secret = body.secret;
    saveSecret(secret);
    console.log(`[register] registered as "${PLUGIN_ID}" with ${MAIN_SERVICE_URL}`);
    startHeartbeat();
  } catch (err) {
    console.error('[register] main service unreachable, retrying shortly:', err instanceof Error ? err.message : err);
    setTimeout(registerWithMain, REGISTER_RETRY_INTERVAL_MS);
  }
}

let heartbeatTimer: NodeJS.Timeout | undefined;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    try {
      await fetch(`${MAIN_SERVICE_URL}/plugins/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret ?? '' },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });
    } catch (err) {
      console.error('[heartbeat] failed:', err instanceof Error ? err.message : err);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// --- The actual plugin logic ---
interface PluginMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  sender: string;
  senderName?: string;
  timestamp: number;
  text: string;
}

interface OnMessageBody {
  requestId: string;
  chatJid: string;
  message: PluginMessage;
  history: PluginMessage[];
  config: { keyword: string; reply: string };
}

async function handleMessage(body: OnMessageBody): Promise<void> {
  const { requestId, chatJid, message, config } = body;
  console.log(`[on-message] requestId=${requestId} chatJid=${chatJid} text=${JSON.stringify(message.text)}`);
  if (!message.text.toLowerCase().includes(config.keyword.toLowerCase())) {
    console.log(`[on-message] "${config.keyword}" not found — no reply`);
    return;
  }

  // Simulates doing real work (e.g. calling an LLM) before answering — this
  // is exactly why the contract is async: main already moved on by the time
  // this resolves.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    const res = await fetch(`${MAIN_SERVICE_URL}/plugins/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret ?? '' },
      body: JSON.stringify({ pluginId: PLUGIN_ID, requestId, chatJid, reply: config.reply }),
    });
    if (!res.ok) {
      console.error(`[callback] rejected (${res.status}) for requestId=${requestId} — likely expired/superseded, dropping.`);
    }
  } catch (err) {
    console.error('[callback] failed to reach main service:', err instanceof Error ? err.message : err);
  }
}

const app = express();
app.use(express.json());

app.post('/on-message', (req, res) => {
  // Best-effort verification that this call actually came from the main
  // service we registered with — main can't force us to check this, but we
  // should anyway.
  if (req.header('X-Plugin-Secret') !== secret) {
    res.status(401).json({ error: 'Invalid secret.' });
    return;
  }

  // Ack immediately — main only waits a few seconds for this response and
  // doesn't care about its body. Do the real work after responding.
  res.json({ ok: true });
  void handleMessage(req.body as OnMessageBody).catch((err) => console.error('[on-message] handler threw:', err));
});

app.listen(PORT, () => {
  console.log(`Remote plugin template listening on port ${PORT}`);
  void registerWithMain();
});

async function shutdown(): Promise<void> {
  console.log('[shutdown] unregistering...');
  try {
    await fetch(`${MAIN_SERVICE_URL}/plugins/register`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Plugin-Secret': secret ?? '' },
      body: JSON.stringify({ pluginId: PLUGIN_ID }),
    });
  } catch (err) {
    console.error('[shutdown] unregister failed (continuing shutdown anyway):', err instanceof Error ? err.message : err);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
