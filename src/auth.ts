import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { scopes } from './config.js';

const exec = promisify(execFile);
export interface Token { access_token: string; refresh_token: string; expires_at: number }
export interface Vault { read(): Promise<Token | undefined>; write(token: Token): Promise<void> }

export class KeychainVault implements Vault {
  constructor(private clientId: string) {}
  async read(): Promise<Token | undefined> {
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', 'personal-spotify-mcp', '-a', this.clientId, '-w']);
      return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as Token;
    } catch (error) {
      if ((error as { code?: number }).code === 44) return undefined;
      throw new Error('Cannot read Spotify credentials from macOS Keychain. Unlock Keychain and try again.');
    }
  }
  async write(token: Token): Promise<void> {
    // Interactive stdin keeps the credential out of command-line arguments.
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic += String(chunk); });
      child.on('error', () => reject(new Error('Cannot start macOS Keychain helper.')));
      child.on('close', code => code === 0 && !/SecKeychain|SecItem|error|failed/i.test(diagnostic)
        ? resolve() : reject(new Error('Cannot save Spotify credentials to macOS Keychain.')));
      child.stdin.on('error', () => reject(new Error('Keychain helper closed unexpectedly.')));
      child.stdin.end(`add-generic-password -U -s personal-spotify-mcp -a ${this.clientId} -w ${encoded}\n`);
    });
  }
}

export async function exchangeToken(params: URLSearchParams, fetcher: typeof fetch = fetch): Promise<{access_token: string; refresh_token?: string; expires_in: number}> {
  const response = await fetcher('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Spotify authorization failed (${response.status}). Run the login command again.`);
  const data = await response.json() as {access_token: string; refresh_token?: string; expires_in: number};
  if (!data.access_token || !Number.isFinite(data.expires_in)) throw new Error('Spotify returned an invalid token response.');
  return data;
}

export class Auth {
  private refreshing?: Promise<Token>;
  private cached?: Token;
  constructor(private clientId: string, private vault: Vault, private fetcher: typeof fetch = fetch) {}
  async accessToken(force = false): Promise<string> {
    const saved = this.cached ?? await this.vault.read();
    if (!saved) throw new Error('Spotify is not connected. Run the login command first.');
    this.cached = saved;
    if (!force && saved.expires_at > Date.now() + 60_000) return saved.access_token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const response = await exchangeToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: this.clientId }), this.fetcher);
        const token = { access_token: response.access_token, refresh_token: response.refresh_token ?? saved.refresh_token, expires_at: Date.now() + response.expires_in * 1000 };
        await this.vault.write(token);
        this.cached = token;
        return token;
      })().finally(() => { this.refreshing = undefined; });
    }
    return (await this.refreshing).access_token;
  }
}

export async function login(clientId: string, redirect: URL, vault: Vault): Promise<void> {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const server = createServer();
  let timer: NodeJS.Timeout | undefined;
  let consuming = false;
  const callback = new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirect.origin);
      if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const received = Buffer.from(url.searchParams.get('state') ?? '');
      if (received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
        res.writeHead(400).end('Invalid login state.'); return;
      }
      if (consuming) { res.writeHead(409).end('Login already received.'); return; }
      consuming = true;
      res.setHeader('Cache-Control', 'no-store');
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        res.writeHead(400).end('Spotify authorization was denied.'); reject(new Error('Spotify authorization was denied.')); return;
      }
      res.end('Spotify authorization received. Return to the terminal to check completion.');
      resolve(url.searchParams.get('code')!);
    });
    timer = setTimeout(() => reject(new Error('Spotify login timed out after five minutes.')), 300_000);
  });
  // Attach a handler while the listener and browser are starting.
  void callback.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(redirect.port), '127.0.0.1', resolve);
    });
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect.href, scope: scopes.join(' '), state, code_challenge_method: 'S256', code_challenge: challenge }).toString();
    console.error('Opening Spotify login in your browser.');
    await exec('/usr/bin/open', [url.href]);
    const code = await callback;
    const response = await exchangeToken(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect.href, code_verifier: verifier }));
    if (!response.refresh_token) throw new Error('Spotify did not return a refresh token. Repeat login.');
    await vault.write({ access_token: response.access_token, refresh_token: response.refresh_token, expires_at: Date.now() + response.expires_in * 1000 });
    console.error('Spotify connected. Credentials saved to macOS Keychain.');
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
