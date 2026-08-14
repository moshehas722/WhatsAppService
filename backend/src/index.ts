import 'dotenv/config';
import cors from 'cors';
import https from 'https';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiRouter } from './routes/api';
import { pluginRegistrationRouter } from './routes/pluginRegistration';
import { pluginCallbackRouter } from './routes/pluginCallback';
import { createMcpServer } from './mcpServer';
import { getOrCreateSelfSignedCert } from './tls';
import { connectToWhatsApp } from './whatsapp';
import { loadPersistedRemoteRegistrations } from './plugins/remoteRegistry';
import { startPendingRepliesSweep } from './plugins/pendingReplies';

loadPersistedRemoteRegistrations();
startPendingRepliesSweep();

const app = express();
app.use(cors());
app.use(express.json());

const mcpMethodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  console.log(`[req] ${req.method} ${req.originalUrl} origin=${req.headers.origin ?? 'none'}`);
  res.on('finish', () => {
    console.log(`[res] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.use(apiRouter);
app.use(pluginRegistrationRouter);
app.use(pluginCallbackRouter);

// Stateless MCP over Streamable HTTP: the SDK requires a fresh server+transport
// pair per request in stateless mode (sessionIdGenerator undefined) — reusing
// one transport across requests throws "Stateless transport cannot be reused".
// Each pair is cheap to create; all of them share the same underlying WhatsApp
// connection via whatsapp.ts's module-level state.
app.post('/mcp', async (req, res) => {
  console.log('[mcp] handling POST /mcp', JSON.stringify(req.body));
  try {
    const mcpServer = createMcpServer();
    const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void mcpTransport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(mcpTransport);
    await mcpTransport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] handleRequest threw:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' }, id: null });
    }
  }
});
app.get('/mcp', mcpMethodNotAllowed);
app.delete('/mcp', mcpMethodNotAllowed);

app.use((req: Request, res: Response) => {
  console.warn(`[404] ${req.method} ${req.originalUrl} did not match any route`);
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[error] ${req.method} ${req.originalUrl} threw:`, err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT) || 3000;
const httpsPort = Number(process.env.HTTPS_PORT) || 3443;

app.listen(port, '0.0.0.0', () => {
  console.log(`WhatsApp sender API listening on http://0.0.0.0:${port} (reachable via 127.0.0.1 and localhost)`);
  console.log(`Control panel: http://localhost:${port}/`);
  console.log(`MCP endpoint (HTTP) available at http://localhost:${port}/mcp`);
  console.log('Waiting for QR code... check the terminal, GET /qr, or the control panel');
});

getOrCreateSelfSignedCert()
  .then(({ key, cert }) => {
    https.createServer({ key, cert }, app).listen(httpsPort, '0.0.0.0', () => {
      console.log(`HTTPS (self-signed, localhost only) listening on https://localhost:${httpsPort}`);
      console.log(`MCP endpoint (HTTPS) available at https://localhost:${httpsPort}/mcp`);
      console.log(
        `NOTE: the certificate is self-signed. If a browser-based client rejects it, open https://localhost:${httpsPort}/health directly in that browser once and accept the security warning ("Advanced" -> "Proceed to localhost") to trust it for that origin.`,
      );
    });
  })
  .catch((err) => {
    console.error('Failed to start HTTPS server:', err);
  });

connectToWhatsApp().catch((err) => {
  console.error('Failed to connect to WhatsApp:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
