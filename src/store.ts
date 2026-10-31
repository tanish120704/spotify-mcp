import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Track } from './spotify.js';

const trackSchema = z.object({ id: z.string(), uri: z.string(), name: z.string(), artists: z.array(z.string()), duration_ms: z.number(), explicit: z.boolean(), url: z.string() });
const sessionSchema = z.object({
  id: z.string(), created_at: z.string(), tracks: z.array(trackSchema),
  playback: z.enum(['pending', 'requested', 'playing', 'unconfirmed', 'failed']), device_id: z.string(),
  playlist: z.object({ id: z.string(), url: z.string(), name: z.string(), complete: z.boolean() }).optional(),
});
const stateSchema = z.object({ version: z.literal(1), catalog: z.record(trackSchema), sessions: z.array(sessionSchema),
  album_devices: z.record(z.number()).default({}),
});
export type Session = z.infer<typeof sessionSchema>;
type State = z.infer<typeof stateSchema>;

export class Store {
  constructor(private directory: string) {}
  private get path() { return join(this.directory, 'state.json'); }
  async read(): Promise<State> {
    try { return stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, catalog: {}, sessions: [], album_devices: {} };
      throw new Error('Cannot read session state. Back up and inspect state.json before continuing; it was not overwritten.');
    }
  }
  private async write(state: State) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  async remember(tracks: Track[]) {
    const state = await this.read();
    for (const track of tracks) { delete state.catalog[track.uri]; state.catalog[track.uri] = track; }
    state.catalog = Object.fromEntries(Object.entries(state.catalog).slice(-1000));
    await this.write(state);
  }
  async prefersAlbum(deviceId: string) {
    const confirmed = (await this.read()).album_devices[deviceId];
    return confirmed !== undefined && Date.now() - confirmed < 7 * 24 * 60 * 60 * 1000;
  }
  async rememberAlbumDevice(deviceId: string) {
    const state = await this.read();
    state.album_devices[deviceId] = Date.now();
    await this.write(state);
  }
  async create(uris: string[], deviceId: string): Promise<Session> {
    const state = await this.read();
    const unique = [...new Set(uris)];
    const tracks = unique.map(uri => {
      const track = state.catalog[uri];
      if (!track) throw new Error(`Track ${uri} was not found in recent search results. Search for it first; do not invent Spotify IDs.`);
      return track;
    });
    const session: Session = { id: randomUUID(), created_at: new Date().toISOString(), tracks, playback: 'pending', device_id: deviceId };
    state.sessions = [...state.sessions, session].slice(-20);
    await this.write(state);
    return session;
  }
  async session(id?: string): Promise<Session> {
    const state = await this.read();
    const session = id ? state.sessions.find(s => s.id === id) : state.sessions.at(-1);
    if (!session) throw new Error('No matching listening session. Play a track selection first.');
    return session;
  }
  async update(session: Session) {
    const state = await this.read();
    const index = state.sessions.findIndex(s => s.id === session.id);
    if (index < 0) throw new Error('Session no longer exists.');
    state.sessions[index] = session;
    await this.write(state);
  }
}
