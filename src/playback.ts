import { setTimeout as delay } from 'node:timers/promises';
import { Spotify, type Device } from './spotify.js';

export type Timing = {step: string; ms: number};
export interface PlaybackResult {
  verified: boolean; recovery_used: boolean; timings: Timing[];
  method: 'track_list' | 'album_queue'; queue_complete: boolean; warning?: string;
}

export class Playback {
  constructor(private spotify: Spotify, private wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, {signal})) {}

  async start(device: Device, uris: string[], signal: AbortSignal, preferAlbum = false): Promise<PlaybackResult> {
    const timings: Timing[] = [];
    const timed = async <T>(step: string, operation: () => Promise<T>) => {
      signal.throwIfAborted();
      const started = performance.now();
      try { return await operation(); }
      finally { timings.push({step, ms: Math.round(performance.now() - started)}); }
    };
    const activate = async () => {
      await timed('activate_device', () => this.spotify.request('/me/player', 'PUT', {device_ids: [device.id], play: false}, signal));
      // Spotify does not guarantee ordering between separate player commands.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await this.wait(200, signal);
        const devices = await timed('verify_device', () => this.spotify.devices(signal));
        if (devices.some(d => d.id === device.id && d.is_active && !d.is_restricted)) return true;
      }
      return false;
    };
    let commandStarted = performance.now();
    const baseline = await timed('inspect_playback', () => this.spotify.state(signal));
    const play = () => {
      commandStarted = performance.now();
      return timed('start_tracks', () => this.spotify.request(`/me/player/play?device_id=${encodeURIComponent(device.id!)}`, 'PUT', {uris, position_ms: 0}, signal));
    };
    const verify = async () => {
      for (const pause of [0, 150, 350, 500]) {
        if (pause) await this.wait(pause, signal);
        const state = await timed('verify_playback', () => this.spotify.state(signal));
        const sameBefore = baseline?.device.id === device.id && (baseline.item?.uri === uris[0] || baseline.item?.linked_from?.uri === uris[0]);
        const fresh = !sameBefore || (state?.timestamp !== undefined && baseline?.timestamp !== undefined
          ? state.timestamp > baseline.timestamp : (state?.progress_ms ?? Infinity) < (baseline?.progress_ms ?? 0));
        const nearStart = (state?.progress_ms ?? Infinity) <= performance.now() - commandStarted + 1500;
        if (state?.is_playing && state.device.id === device.id && (state.item?.uri === uris[0] || state.item?.linked_from?.uri === uris[0]) && fresh && nearStart) return true;
        // Another device started playing: do not repeatedly steal playback back.
        if (state?.is_playing && state.device.id !== device.id) throw new Error('Playback moved to another device. Select your intended device before retrying.');
      }
      return false;
    };
    const result = (verified: boolean, method: PlaybackResult['method'], queueComplete = verified): PlaybackResult => ({
      verified, method, queue_complete: queueComplete, recovery_used: method === 'album_queue' && !preferAlbum, timings,
    });
    if (!device.is_active && !await activate()) return result(false, preferAlbum ? 'album_queue' : 'track_list');
    if (!preferAlbum) {
      await play();
      if (await verify()) return result(true, 'track_list');
    }

    // Spotify desktop can silently reject `uris`. Start via an album context
    // instead, then enqueue the requested tail ahead of that album's next tracks.
    const track = await timed('resolve_album', () => this.spotify.request<{uri: string; album: {uri: string}}>('/tracks/' + encodeURIComponent(uris[0].split(':')[2]), 'GET', undefined, signal));
    if (!track.album?.uri?.startsWith('spotify:album:')) throw new Error('Spotify did not return an album context for the first track.');
    commandStarted = performance.now();
    await timed('start_album_track', () => this.spotify.request(`/me/player/play?device_id=${encodeURIComponent(device.id!)}`, 'PUT', {context_uri: track.album.uri, offset: {uri: track.uri}, position_ms: 0}, signal));
    if (!await verify()) return result(false, 'album_queue');
    if (uris.length === 1) return result(true, 'album_queue');

    try {
      type Queue = {queue: {uri: string; linked_from?: {uri: string}}[]};
      const tail = uris.slice(1);
      const matches = (item: Queue['queue'][number] | undefined, uri: string) => item?.uri === uri || item?.linked_from?.uri === uri;
      const existing = await timed('inspect_queue', () => this.spotify.request<Queue>('/me/player/queue', 'GET', undefined, signal));
      let prefix = 0;
      while (prefix < tail.length && matches(existing.queue[prefix], tail[prefix])) prefix++;
      for (const uri of tail.slice(prefix)) {
        // Never retry an ambiguous enqueue: it could add a duplicate.
        await timed('enqueue_track', () => this.spotify.request('/me/player/queue?' + new URLSearchParams({uri, device_id: device.id!}), 'POST', undefined, signal));
      }
      for (const pause of [0, 200, 400]) {
        if (pause) await this.wait(pause, signal);
        const queue = await timed('verify_queue', () => this.spotify.request<Queue>('/me/player/queue', 'GET', undefined, signal));
        if (tail.every((uri, i) => matches(queue.queue[i], uri))) return result(true, 'album_queue');
      }
      return {...result(true, 'album_queue', false), warning: 'The first track is playing, but the requested queue order could not be confirmed. Existing queued music may precede part of the selection. Do not blindly enqueue again.'};
    } catch {
      return {...result(true, 'album_queue', false), warning: 'The first track was verified playing, but queue setup did not finish within the request budget or Spotify returned an error. Some tracks may already be queued. Inspect the queue before retrying; do not repeat play automatically.'};
    }
  }
}
