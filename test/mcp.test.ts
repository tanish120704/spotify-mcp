import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { acquireLease } from '../src/lease.js';
import { createServer } from '../src/server.js';
import { App, playbackSchema } from '../src/app.js';
import { Store } from '../src/store.js';
import { Spotify, SpotifyError } from '../src/spotify.js';
import { Auth, type Token } from '../src/auth.js';

const uri = `spotify:track:${'a'.repeat(22)}`;
const secondUri = `spotify:track:${'b'.repeat(22)}`;
const rawTrack = { id: 'a'.repeat(22), uri, name: 'Night Study', artists: [{name: 'Example Artist'}], duration_ms: 240000, explicit: false, external_urls: {spotify: `https://open.spotify.com/track/${'a'.repeat(22)}`} };
const track = { ...rawTrack, artists: ['Example Artist'], url: rawTrack.external_urls.spotify };
const device = {id: 'mac-device', name: 'My Mac', type: 'Computer', is_active: true, is_restricted: false};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
type Call = {path: string; method: string; body: any};

async function fixture(t: TestContext, handler?: (call: Call) => Response) {
  const directory = await mkdtemp(join(tmpdir(), 'spotify-mcp-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const calls: Call[] = [];
  let playing = false;
  const fetcher = (async (url, options) => {
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    const parsed = new URL(String(url));
    const call = {path: parsed.pathname + parsed.search, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined};
    calls.push(call);
    if (handler) return handler(call);
    if (call.path.startsWith('/v1/me/player/play?')) playing = true;
    if (call.path.startsWith('/v1/search?')) return json({tracks: {items: [rawTrack], next: null}});
    if (call.path === '/v1/me/player/devices') return json({devices: [device]});
    if (call.path === '/v1/me/player' && call.method === 'GET') return playing ? json({is_playing: true, progress_ms: 100, device, item: {uri, name: track.name}}) : new Response(null, {status: 204});
    if (call.path === '/v1/me/playlists') return json({id: 'playlist-id', external_urls: {spotify: 'https://open.spotify.com/playlist/playlist-id'}}, 201);
    return new Response(null, {status: 204});
  }) as typeof fetch;
  const store = new Store(directory);
  const spotify = new Spotify(async () => 'test-token', fetcher);
  return {app: new App(spotify, store), store, spotify, calls, directory};
}

test('MCP discovery and search → temporary playback → explicit save; repeat save reuses playlist', async t => {
  const {app, calls} = await fixture(t);
  const server = createServer(app);
  const client = new Client({name: 'test-assistant', version: '1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['search_music', 'control_playback', 'save_playlist']);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({name, arguments: args});
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as {text: string}[])[0].text);
  };
  const search = await call('search_music', {query: 'ambient instrumental'});
  assert.equal(search.tracks[0].uri, uri);
  const session = await call('control_playback', {action: 'play', track_uris: [uri, uri], device_name: 'My Mac'});
  assert.equal(session.tracks.length, 1);
  assert.equal(session.duration_minutes, 4);
  assert.equal(calls.filter(c => c.path.includes('playlists')).length, 0);
  assert.equal(session.verified, true);
  assert.equal(session.playback, 'playing');
  assert.deepEqual(calls.find(c => c.path.startsWith('/v1/me/player/play?'))?.body, {uris: [uri], position_ms: 0});
  await call('control_playback', {action: 'skip'});
  const saved = await call('save_playlist', {name: 'Midnight Coding', session_id: session.session_id});
  assert.equal(saved.complete, true);
  await call('save_playlist', {name: 'Again', session_id: session.session_id});
  assert.equal(calls.filter(c => c.path === '/v1/me/playlists').length, 1);
  assert.equal(calls.find(c => c.path === '/v1/me/playlists')?.body.public, false);
  assert.deepEqual(calls.find(c => c.path === '/v1/playlists/playlist-id/items')?.body, {uris: [uri]});
});

test('session survives restart and rejects invented track IDs before playback', async t => {
  const {app, store, directory, calls} = await fixture(t);
  await app.search({query: 'focus'});
  await assert.rejects(app.playback({action: 'play', track_uris: [secondUri]}), /not found in recent search/);
  assert.equal(calls.filter(c => c.path.startsWith('/v1/me/player/play?')).length, 0);
  await app.playback({action: 'play', track_uris: [uri]});
  const reloaded = await new Store(directory).session();
  assert.equal(reloaded.tracks[0].uri, uri);
  assert.equal(reloaded.id, (await store.session()).id);
});

test('partially filled playlist is checkpointed and reused on retry', async t => {
  let filling = 0;
  const {app, store, calls} = await fixture(t, call => {
    if (call.path === '/v1/me/playlists') return json({id: 'existing', external_urls: {spotify: 'https://open.spotify.com/playlist/existing'}}, 201);
    if (call.path === '/v1/playlists/existing/items' && filling++ === 0) return json({}, 503);
    return new Response(null, {status: 204});
  });
  await store.remember([track]);
  await store.create([uri], 'mac-device');
  await assert.rejects(app.save({name: 'Focus'}), /exists but filling it did not complete/);
  assert.equal((await store.session()).playlist?.complete, false);
  await app.save({name: 'Focus'});
  assert.equal(calls.filter(c => c.path === '/v1/me/playlists').length, 1);
  assert.equal((await store.session()).playlist?.complete, true);
});

test('device selection never guesses between multiple devices', async t => {
  const {spotify} = await fixture(t, () => json({devices: [{...device, is_active: false}, {...device, id: 'phone', name: 'Phone', is_active: false}]}));
  await assert.rejects(spotify.chooseDevice(), /unambiguous/);
  assert.equal((await spotify.chooseDevice(undefined, 'my mac')).id, 'mac-device');
  await assert.rejects(spotify.chooseDevice('missing'), /unambiguous/);
});

test('playback errors retain the selected session without claiming success', async t => {
  const {app, store} = await fixture(t, call => call.path.endsWith('/devices') ? json({devices: [device]}) : json({}, 403));
  await store.remember([track]);
  await assert.rejects(app.playback({action: 'play', track_uris: [uri]}), /denied access/);
  assert.equal((await store.session()).playback, 'failed');
});

test('401 refreshes once; rate limits return retry information without repeating writes', async () => {
  const forced: (boolean | undefined)[] = [];
  let requests = 0;
  const spotify = new Spotify(async force => { forced.push(force); return 'token'; }, (async () => ++requests === 1 ? json({}, 401) : new Response(null, {status: 204})) as typeof fetch);
  await spotify.request('/me/player/pause', 'PUT');
  assert.deepEqual(forced, [false, true]);
  let writes = 0;
  const limited = new Spotify(async () => 'token', (async () => { writes++; return new Response('', {status: 429, headers: {'Retry-After': '30'}}); }) as typeof fetch);
  await assert.rejects(limited.request('/me/playlists', 'POST', {}), error => error instanceof SpotifyError && error.retryAfter === '30');
  assert.equal(writes, 1);
});

test('concurrent token refreshes share a request and preserve refresh token when omitted', async () => {
  let token: Token = {access_token: 'expired', refresh_token: 'refresh', expires_at: 0};
  let requests = 0;
  const auth = new Auth('client', {read: async () => token, write: async value => { token = value; }}, (async (_url, options) => {
    requests++;
    assert.equal((options?.body as URLSearchParams).get('grant_type'), 'refresh_token');
    return json({access_token: 'new', expires_in: 3600});
  }) as typeof fetch);
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), ['new', 'new']);
  assert.equal(requests, 1);
  assert.equal(token.refresh_token, 'refresh');
});

test('missing login provides an actionable error without an API request', async () => {
  const auth = new Auth('client', {read: async () => undefined, write: async () => {}}, (async () => { throw new Error('must not call'); }) as typeof fetch);
  await assert.rejects(auth.accessToken(), /login command first/);
});

test('corrupt persistent state is not silently replaced', async t => {
  const {store, directory} = await fixture(t);
  await writeFile(join(directory, 'state.json'), 'broken');
  await assert.rejects(store.remember([track]), /not overwritten/);
});

test('device workaround survives restart and expires after seven days', async t => {
  const {store, directory} = await fixture(t);
  assert.equal(await store.prefersAlbum('mac'), false);
  await store.rememberAlbumDevice('mac');
  assert.equal(await new Store(directory).prefersAlbum('mac'), true);
  const {readFile} = await import('node:fs/promises');
  const path = join(directory, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.album_devices.mac = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await writeFile(path, JSON.stringify(state));
  assert.equal(await store.prefersAlbum('mac'), false);
});

test('invalid playback inputs fail before calling Spotify', () => {
  assert.equal(playbackSchema.safeParse({action: 'play'}).success, false);
  assert.equal(playbackSchema.safeParse({action: 'play', track_uris: ['invented']}).success, false);
  assert.equal(playbackSchema.safeParse({action: 'pause', track_uris: [uri]}).success, false);
});

test('successful plain-text player acknowledgements are not treated as failed writes', async () => {
  let requests = 0;
  const spotify = new Spotify(async () => 'token', (async () => { requests++; return new Response('acknowledged', {status: 200}); }) as typeof fetch);
  assert.equal(await spotify.request('/me/player/queue?uri=example', 'POST'), 'acknowledged');
  assert.equal(requests, 1);
});

test('separate server instances cannot write the same data directory', async t => {
  const {directory} = await fixture(t);
  const release = acquireLease(directory);
  assert.throws(() => acquireLease(directory), /Another Spotify MCP instance/);
  release();
  const nextRelease = acquireLease(directory);
  nextRelease();
});

test('actual stdio process initializes, discovers tools, and releases its session lock', async t => {
  const {directory} = await fixture(t);
  const client = new Client({name: 'stdio-smoke-test', version: '1.0.0'});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {SPOTIFY_CLIENT_ID: 'a'.repeat(32), SPOTIFY_MCP_DATA_DIR: directory},
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  const invalid = await client.callTool({name: 'control_playback', arguments: {action: 'play'}});
  assert.equal(invalid.isError, true);
  await client.close();
  const release = acquireLease(directory);
  release();
});
