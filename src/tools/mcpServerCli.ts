import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { kaizenMCPServer } from './mcpServer';

async function main() {
  const transport = new StdioServerTransport();
  await kaizenMCPServer.getSDKServer().connect(transport);
  console.error('[KaizenMCPServerCLI] Kaizen MCP Server listening on stdio transport.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[KaizenMCPServerCLI] Fatal error in stdio server process:', err);
    process.exit(1);
  });
}
