// Read-only live smoke test. Start with SPOTIFY_CLIENT_ID set after login.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'spotify-connection-check', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: {
    SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID ?? '',
    ...(process.env.SPOTIFY_MCP_DATA_DIR ? { SPOTIFY_MCP_DATA_DIR: process.env.SPOTIFY_MCP_DATA_DIR } : {}),
  },
  stderr: 'inherit',
});
try {
  await client.connect(transport);
  console.log('Tools:', (await client.listTools()).tools.map(tool => tool.name).join(', '));
  for (const [name, args] of [
    ['search_music', { query: 'ambient instrumental', limit: 3 }],
    ['control_playback', { action: 'devices' }],
    ['control_playback', { action: 'status' }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    console.log(name, JSON.stringify(result));
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
