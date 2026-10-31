export interface Track {
  id: string; uri: string; name: string; artists: string[]; duration_ms: number; explicit: boolean; url: string;
}
export interface Device { id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean }
export interface PlaybackState {
  is_playing: boolean; progress_ms: number; timestamp?: number;
  device: {id: string; name: string};
  item: {uri: string; name: string; linked_from?: {uri: string}} | null;
}

async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
interface RawTrack { id: string; uri: string; name: string; artists: {name: string}[]; duration_ms: number; explicit: boolean; external_urls: {spotify: string}; is_playable?: boolean }
export class SpotifyError extends Error {
  constructor(public status: number, message: string, public retryAfter?: string) { super(message); }
}

export class Spotify {
  constructor(private token: (force?: boolean) => Promise<string>, private fetcher: typeof fetch = fetch) {}
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const access = await untilAborted(this.token(attempt === 1), signal);
      let response: Response;
      try {
        response = await this.fetcher(`https://api.spotify.com/v1${path}`, {
          method, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error(`Spotify ${method} request did not complete. Its outcome may be unknown; check status before retrying a write.`);
      }
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) {
        const hints: Record<number, string> = {
          401: 'Spotify login expired or was revoked. Run login again.',
          403: 'Spotify denied access. Check Premium, developer app access, and login scopes.',
          404: 'Spotify resource or playback device is unavailable. Open Spotify on your Mac and list devices again.',
          429: 'Spotify rate or quota limit reached. Wait before retrying.',
        };
        throw new SpotifyError(response.status, hints[response.status] ?? `Spotify returned HTTP ${response.status}.`, response.headers.get('retry-after') ?? undefined);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      // Some successful player commands return a plain-text acknowledgement.
      if (!(response.headers.get('content-type') ?? '').includes('json')) return text as T;
      return JSON.parse(text) as T;
    }
    throw new Error('Spotify authentication failed.');
  }
  async search(query: string, limit: number, offset: number): Promise<{tracks: Track[]; next_offset: number | null}> {
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit), offset: String(offset) });
    const data = await this.request<{tracks: {items: (RawTrack | null)[]; next: string | null}}>(`/search?${params}`);
    return {
      tracks: data.tracks.items.filter((t): t is RawTrack => !!t && t.is_playable !== false).map(t => ({ id: t.id, uri: t.uri, name: t.name, artists: t.artists.map(a => a.name), duration_ms: t.duration_ms, explicit: t.explicit, url: t.external_urls.spotify })),
      next_offset: data.tracks.next ? offset + limit : null,
    };
  }
  async devices(signal?: AbortSignal): Promise<Device[]> { return (await this.request<{devices: Device[]}>('/me/player/devices', 'GET', undefined, signal)).devices; }
  async state(signal?: AbortSignal): Promise<PlaybackState | undefined> { return this.request('/me/player', 'GET', undefined, signal); }
  async chooseDevice(id?: string, name?: string, signal?: AbortSignal): Promise<Device> {
    const devices = (await this.devices(signal)).filter(d => !!d.id && !d.is_restricted);
    const matching = id ? devices.filter(d => d.id === id) : name ? devices.filter(d => d.name.toLowerCase() === name.toLowerCase()) : devices.filter(d => d.is_active);
    if (matching.length === 1) return matching[0];
    if (!id && !name && matching.length === 0 && devices.length === 1) return devices[0];
    throw new Error('No unambiguous available Spotify device. Use action=devices, then supply device_id or exact device_name. Open Spotify on your Mac if it is missing.');
  }
}
