import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { Auth, KeychainVault, login } from './auth.js';
import { Spotify } from './spotify.js';
import { Store } from './store.js';
import { App } from './app.js';
import { createServer } from './server.js';
import { acquireLease } from './lease.js';

try {
  if (process.platform !== 'darwin') throw new Error('This version uses macOS Keychain and requires a Mac.');
  const settings = config();
  const vault = new KeychainVault(settings.clientId);
  if (process.argv[2] === 'login') {
    await login(settings.clientId, settings.redirect, vault);
  } else if (process.argv.length > 2) {
    throw new Error('Usage: node dist/index.js [login]');
  } else {
    const release = acquireLease(settings.dataDir);
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { release(); process.exit(0); });
    }
    const auth = new Auth(settings.clientId, vault);
    const app = new App(new Spotify(force => auth.accessToken(force)), new Store(settings.dataDir));
    const server = createServer(app);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  // stdout is exclusively reserved for MCP protocol messages.
  console.error(error instanceof Error ? error.message : 'Spotify MCP failed.');
  process.exitCode = 1;
}
