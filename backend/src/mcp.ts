import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcpServer';
import { connectToWhatsApp } from './whatsapp';

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  connectToWhatsApp().catch((err) => {
    console.error('Failed to connect to WhatsApp:', err);
  });
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
