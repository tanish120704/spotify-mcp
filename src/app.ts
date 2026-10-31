import { Spotify, SpotifyError } from './spotify.js';
import { Store } from './store.js';
import type { Session } from './store.js';
import { z } from 'zod';
import { Playback, type PlaybackResult } from './playback.js';

export const searchSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).default(10), offset: z.number().int().min(0).max(1000).default(0) }).strict();
const selection = { track_uris: z.array(z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/)).min(1).max(100), device_id: z.string().min(1).optional(), device_name: z.string().min(1).optional() };
export const playbackSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play'), ...selection }).strict(),
  z.object({ action: z.literal('devices') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('session'), session_id: z.string().uuid().optional() }).strict(),
  z.object({ action: z.enum(['pause', 'resume', 'skip']), device_id: selection.device_id, device_name: selection.device_name }).strict(),
]);
export const saveSchema = z.object({ session_id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), description: z.string().max(300).default('Created from a temporary listening session.') }).strict();

function summary(session: Session) {
  return { session_id: session.id, playback: session.playback, device_id: session.device_id, tracks: session.tracks, duration_minutes: Math.round(session.tracks.reduce((sum, t) => sum + t.duration_ms, 0) / 6000) / 10, saved_playlist: session.playlist ?? null };
}

export class App {
  // Serialize tool operations: state writes and playlist creation must not overlap.
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private spotify: Spotify, private store: Store) {}
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  async search(input: z.input<typeof searchSchema>) {
    const { query, limit, offset } = searchSchema.parse(input);
    const result = await this.spotify.search(query, limit, offset);
    await this.store.remember(result.tracks);
    return { ...result, note: 'Search metadata does not verify absence of vocals. Use exact instrumental versions where identifiable.' };
  }
  async playback(input: z.input<typeof playbackSchema>): Promise<unknown> {
    const args = playbackSchema.parse(input);
    if (args.action === 'devices') return { devices: await this.spotify.devices() };
    if (args.action === 'session') return summary(await this.store.session(args.session_id));
    if (args.action === 'status') {
      const status = await this.spotify.state();
      return status ? { is_playing: status.is_playing, progress_ms: status.progress_ms, device: {id: status.device.id, name: status.device.name}, track: status.item ? {uri: status.item.uri, name: status.item.name} : null } : { is_playing: false, note: 'No playback state. Open Spotify and list devices.' };
    }
    const started = performance.now();
    const deadline = args.action === 'play' ? AbortSignal.timeout(8_000) : undefined;
    const device = await this.spotify.chooseDevice(args.device_id, args.device_name, deadline);
    const deviceMs = Math.round(performance.now() - started);
    const suffix = `?device_id=${encodeURIComponent(device.id!)}`;
    if (args.action === 'play') {
      const session = await this.store.create(args.track_uris, device.id!);
      let result: PlaybackResult;
      try {
        result = await new Playback(this.spotify).start(device, session.tracks.map(t => t.uri), deadline!, await this.store.prefersAlbum(device.id!));
      } catch (error) {
        session.playback = 'failed';
        await this.store.update(session);
        throw new Error(`${deadline?.aborted ? 'Playback exceeded its 8-second Spotify request budget.' : error instanceof Error ? error.message : 'Playback failed.'} Session ${session.id} is retained. Check status before retrying; do not automatically repeat play.`);
      }
      session.playback = result.verified ? 'playing' : 'unconfirmed';
      await this.store.update(session);
      if (result.verified && result.method === 'album_queue') await this.store.rememberAlbumDevice(device.id!);
      return { ...summary(session), verified: result.verified, recovery_used: result.recovery_used, method: result.method, queue_complete: result.queue_complete,
        timing_ms: {total: Math.round(performance.now() - started), device_discovery: deviceMs, steps: result.timings},
        note: result.warning ?? (result.verified ? `Playback verified on the selected device. No playlist was created. ${result.method === 'album_queue' ? 'The album may continue after the selected tracks.' : 'Spotify autoplay/repeat settings remain in effect.'}` : 'Playback could not be verified after bounded recovery. Open Spotify and press Play once, then check status. Do not repeat play automatically or restart the app in a loop.') };
    }
    const route = args.action === 'pause' ? 'pause' : args.action === 'resume' ? 'play' : 'next';
    await this.spotify.request(`/me/player/${route}${suffix}`, args.action === 'skip' ? 'POST' : 'PUT');
    return { action: args.action, device: device.name, status: 'requested' };
  }
  async save(input: z.input<typeof saveSchema>) {
    const args = saveSchema.parse(input);
    const session = await this.store.session(args.session_id);
    if (session.playlist?.complete) return { ...session.playlist, note: 'This session is already saved. No new playlist was created.' };
    if (!session.playlist) {
      const playlist = await this.spotify.request<{id: string; external_urls: {spotify: string}}>('/me/playlists', 'POST', { name: args.name, description: args.description, public: false });
      session.playlist = { id: playlist.id, url: playlist.external_urls.spotify, name: args.name, complete: false };
      // Checkpoint before filling: retries reuse this playlist rather than creating another.
      await this.store.update(session);
    }
    try {
      // Replacing <=100 items is idempotent, unlike appending after an ambiguous failure.
      await this.spotify.request(`/playlists/${encodeURIComponent(session.playlist.id)}/items`, 'PUT', { uris: session.tracks.map(t => t.uri) });
    } catch (error) {
      throw new Error(`Playlist ${session.playlist.url} exists but filling it did not complete. Retry save_playlist with session_id=${session.id} to reuse it. ${error instanceof Error ? error.message : ''}`);
    }
    session.playlist.complete = true;
    await this.store.update(session);
    return session.playlist;
  }
}

export function toolError(error: unknown) {
  const data = error instanceof z.ZodError ? { error: 'Invalid tool input', issues: error.issues.map(i => ({path: i.path, message: i.message})) }
    : { error: error instanceof Error ? error.message : 'Unexpected tool failure.', ...(error instanceof SpotifyError ? {status: error.status, retry_after_seconds: error.retryAfter} : {}) };
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
