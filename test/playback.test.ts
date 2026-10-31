import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playback } from '../src/playback.js';
import { Spotify, SpotifyError, type Device } from '../src/spotify.js';
import { Auth, type Token } from '../src/auth.js';

const uri = 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa';
const device: Device = {id: 'mac', name: 'My Mac', type: 'Computer', is_active: true, is_restricted: false};
const state = (id = 'mac', track = uri) => ({is_playing: true, progress_ms: 100, device: {id, name: id}, item: {uri: track, name: 'Track'}});
const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
const empty = () => new Response(null, {status: 204});

function setup(handler: (path: string, method: string, body: any) => Response) {
  const calls: {path: string; method: string; body: any}[] = [];
  let initialState = true;
  const spotify = new Spotify(async () => 'token', (async (url, options) => {
    const path = new URL(String(url)).pathname.replace('/v1', '');
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({path, method, body});
    if (path === '/me/player' && method === 'GET' && initialState) { initialState = false; return empty(); }
    if (path.startsWith('/tracks/')) return json({uri, album: {uri: 'spotify:album:example'}});
    return handler(path, method, body);
  }) as typeof fetch);
  return {calls, playback: new Playback(spotify, async () => {})};
}

test('healthy device inspects, starts and verifies without transfer or extra polling', async () => {
  const {calls, playback} = setup((path, method) => method === 'GET' ? json(state()) : empty());
  const result = await playback.start(device, [uri], AbortSignal.timeout(1000));
  assert.equal(result.verified, true);
  assert.equal(result.recovery_used, false);
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /me/player', 'PUT /me/player/play', 'GET /me/player']);
  assert.equal(result.timings.length, 3);
});

test('inactive device activation is confirmed before issuing playback', async () => {
  const {calls, playback} = setup((path, method) => path.endsWith('/devices') ? json({devices: [device]}) : method === 'GET' ? json(state()) : empty());
  assert.equal((await playback.start({...device, is_active: false}, [uri], AbortSignal.timeout(1000))).verified, true);
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /me/player', 'PUT /me/player', 'GET /me/player/devices', 'PUT /me/player/play', 'GET /me/player']);
  assert.deepEqual(calls[1].body, {device_ids: ['mac'], play: false});
});

test('delayed successful playback is polled without restarting the track', async () => {
  let reads = 0;
  const {calls, playback} = setup((_path, method) => method === 'GET' ? ++reads < 3 ? empty() : json(state()) : empty());
  assert.equal((await playback.start(device, [uri], AbortSignal.timeout(1000))).verified, true);
  assert.equal(calls.filter(c => c.path === '/me/player/play').length, 1);
});

test('silent acknowledgement gets one recovery then returns unconfirmed, never false success', async () => {
  const {calls, playback} = setup(path => path.endsWith('/devices') ? json({devices: [device]}) : empty());
  const result = await playback.start(device, [uri], AbortSignal.timeout(1000));
  assert.equal(result.verified, false);
  assert.equal(result.recovery_used, true);
  assert.equal(calls.filter(c => c.method === 'PUT' && c.path === '/me/player').length, 0);
  assert.equal(calls.filter(c => c.path === '/me/player/play').length, 2);
  assert.equal(calls.find(c => c.body?.context_uri)?.body.context_uri, 'spotify:album:example');
});

test('album fallback recovers silent track-list playback without a device reset', async () => {
  let albumStarted = false;
  const {calls, playback} = setup((path, method, body) => {
    if (body?.context_uri) albumStarted = true;
    if (path === '/me/player' && method === 'GET') return albumStarted ? json(state()) : empty();
    return empty();
  });
  const result = await playback.start(device, [uri], AbortSignal.timeout(1000));
  assert.equal(result.verified, true);
  assert.equal(result.recovery_used, true);
  assert.equal(calls.filter(c => c.path === '/me/player/play').length, 2);
  assert.equal(calls.filter(c => c.method === 'PUT' && c.path === '/me/player').length, 0);
});

test('a different track is not accepted as confirmation', async () => {
  const {playback} = setup((path, method) => path.endsWith('/devices') ? json({devices: [device]}) : method === 'GET' ? json(state('mac', 'spotify:track:wrong')) : empty());
  assert.equal((await playback.start(device, [uri], AbortSignal.timeout(1000))).verified, false);
});

test('playback moved to another device stops recovery without taking it back', async () => {
  const {calls, playback} = setup((_path, method) => method === 'GET' ? json(state('phone')) : empty());
  await assert.rejects(playback.start(device, [uri], AbortSignal.timeout(1000)), /another device/);
  assert.equal(calls.length, 3);
});

test('unavailable device is not sent a playback command after failed activation', async () => {
  const {calls, playback} = setup(path => path.endsWith('/devices') ? json({devices: []}) : empty());
  assert.equal((await playback.start({...device, is_active: false}, [uri], AbortSignal.timeout(1000))).verified, false);
  assert.equal(calls.filter(c => c.path === '/me/player/play').length, 0);
});

test('rate limits are not retried through recovery', async () => {
  const {calls, playback} = setup(() => new Response('', {status: 429}));
  await assert.rejects(playback.start(device, [uri], AbortSignal.timeout(1000)), e => e instanceof SpotifyError && e.status === 429);
  assert.equal(calls.length, 2);
});

test('shared deadline interrupts a stalled HTTP request', async () => {
  const controller = new AbortController();
  const spotify = new Spotify(async () => 'token', (async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
    controller.abort();
  })) as typeof fetch);
  await assert.rejects(new Playback(spotify).start(device, [uri], controller.signal), /outcome may be unknown/);
});

test('valid credentials are cached in memory and a forced refresh updates the cache', async () => {
  let reads = 0;
  const saved: Token = {access_token: 'old', refresh_token: 'refresh', expires_at: Date.now() + 3600000};
  const auth = new Auth('id', {read: async () => { reads++; return saved; }, write: async () => {}}, (async () => json({access_token: 'new', expires_in: 3600})) as typeof fetch);
  assert.equal(await auth.accessToken(), 'old');
  assert.equal(await auth.accessToken(), 'old');
  assert.equal(reads, 1);
  assert.equal(await auth.accessToken(true), 'new');
  assert.equal(await auth.accessToken(), 'new');
});

test('learned album route skips the broken track-list request and verifies queued order', async () => {
  const second = 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb';
  let queued = false;
  const {calls, playback} = setup((path, method) => {
    if (path === '/me/player/queue' && method === 'POST') { queued = true; return new Response('ok'); }
    if (path === '/me/player/queue') return json({queue: queued ? [{uri: second}] : []});
    if (path === '/me/player' && method === 'GET') return json(state());
    return empty();
  });
  const result = await playback.start(device, [uri, second], AbortSignal.timeout(1000), true);
  assert.equal(result.verified, true);
  assert.equal(result.queue_complete, true);
  assert.equal(result.method, 'album_queue');
  assert.equal(calls.some(c => c.body?.uris), false);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('album fallback does not duplicate the already queued requested prefix', async () => {
  const second = 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb';
  const {calls, playback} = setup((path, method) => path === '/me/player/queue' ? json({queue: [{uri: second}]}) : method === 'GET' ? json(state()) : empty());
  const result = await playback.start(device, [uri, second], AbortSignal.timeout(1000), true);
  assert.equal(result.queue_complete, true);
  assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('partial queue failure preserves verified playback and warns against blind retries', async () => {
  const second = 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb';
  const {calls, playback} = setup((path, method) => {
    if (path === '/me/player/queue') return method === 'POST' ? new Response('', {status: 503}) : json({queue: []});
    return method === 'GET' ? json(state()) : empty();
  });
  const result = await playback.start(device, [uri, second], AbortSignal.timeout(1000), true);
  assert.equal(result.verified, true);
  assert.equal(result.queue_complete, false);
  assert.match(result.warning!, /Some tracks may already be queued/);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('stale state for the same previously playing song does not verify a new start', async () => {
  const stale = {...state(), timestamp: 100, progress_ms: 30000};
  const spotify = new Spotify(async () => 'token', (async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/tracks/')) return json({uri, album: {uri: 'spotify:album:example'}});
    if (options?.method === 'GET') return json(stale);
    return empty();
  }) as typeof fetch);
  const result = await new Playback(spotify, async () => {}).start(device, [uri], AbortSignal.timeout(1000), true);
  assert.equal(result.verified, false);
});
