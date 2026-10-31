import { homedir } from 'node:os';
import { join } from 'node:path';

export function config() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId || !/^[a-f0-9]{32}$/i.test(clientId)) {
    throw new Error('Set SPOTIFY_CLIENT_ID to your Spotify developer app Client ID. No client secret is needed.');
  }
  const redirect = new URL(process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback');
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('SPOTIFY_REDIRECT_URI must be an http://127.0.0.1:<port>/<path> loopback URL.');
  }
  return { clientId, redirect, dataDir: process.env.SPOTIFY_MCP_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'spotify-mcp', clientId) };
}

export const scopes = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-modify-private'];
