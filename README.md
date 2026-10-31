# Personal Spotify MCP

A local TypeScript MCP server for a Mac. Your assistant searches Spotify, curates an ordered track selection, and plays it through Spotify. Listening does **not** create a saved playlist. Save only when you explicitly ask.

No separate AI API or API key is needed: the connected assistant does the reasoning. Spotify Premium and a Spotify developer application are required for live use. This is a personal integration, not an official Spotify MCP server.

## First connection

1. Open [Spotify's developer dashboard](https://developer.spotify.com/dashboard). Create or reuse an app with Web API access. New development apps require Premium and are subject to Spotify's user and request limits.
2. Register this exact redirect URI in the app settings: `http://127.0.0.1:8888/callback`. Use `127.0.0.1`, not `localhost`. Add your Spotify account under Users and Access if required by the dashboard.
3. Copy the **Client ID**. No Client Secret is needed or used.
4. From this directory, run:

   ```sh
   SPOTIFY_CLIENT_ID=YOUR_CLIENT_ID ./scripts/spotify-mcp login
   ```

   Install dependencies and build first (see Development below). The launcher uses Node from PATH or a locally bundled Codex runtime when available. Login opens your browser, binds only to `127.0.0.1`, validates OAuth state, exchanges a PKCE code, and stores tokens in macOS Keychain. The terminal reports whether saving succeeded. Login times out after five minutes.

5. Connect the server using your MCP client's configuration. For clients using `mcpServers`, copy `mcp.config.example.json` and replace the Client ID. Example configuration for a TOML-based MCP client:

   ```toml
   [mcp_servers.spotify]
   command = "/absolute/path/to/spotify-mcp/scripts/spotify-mcp"

   [mcp_servers.spotify.env]
   SPOTIFY_CLIENT_ID = "YOUR_CLIENT_ID"
   ```

   Replace the example command with the absolute path to your clone. For a project-scoped client setup, place the TOML configuration in that project's `.codex/config.toml`; keep your personal configuration outside this source repository. Run one server instance per data directory. Reload the client or start a fresh project chat to load newly added tools.

6. Open Spotify on your Mac. Ask the assistant to search for instrumental coding music and play a selected session on the exact Mac device. The play tool verifies playback and returns its result in the same call.

## Tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `search_music` | `query`, optional `limit` (1–10), `offset` | Searches real Spotify tracks and remembers metadata. Returns URIs, artists, duration, explicit flag, links, and next offset. |
| `control_playback` | `action: devices` | Lists available Spotify Connect devices. |
| `control_playback` | `action: play`, `track_uris`, optional `device_id` or exact `device_name` | Plays 1–100 recently searched tracks with verification and bounded recovery. Returns `verified`, `queue_complete`, `method`, timings, session ID and duration. Replaces the selection without making a playlist. |
| `control_playback` | `action: status` | Checks actual playback. An accepted command alone is not proof audio started. |
| `control_playback` | `action: pause/resume/skip`, optional device | Controls a selected device. Without a device, uses the active one or the sole available one; otherwise asks for an explicit target. |
| `control_playback` | `action: session`, optional `session_id` | Returns the full remembered selection, even after earlier tracks have played. Defaults to latest session. |
| `save_playlist` | `name`, optional `session_id`, `description` | Saves a session as a private playlist. Defaults to latest session. Repeated calls return its existing playlist; another name does not create a second copy. |

Example assistant workflow:

```text
User: Find roughly two hours of instrumental late-night coding music
      and play it on my Mac. Don't save a playlist.

Assistant → search_music(query="ambient instrumental", limit=10)
Assistant → search_music(query="minimal electronic instrumental", limit=10)
Assistant → more searches/pages as needed
Assistant chooses verified returned URIs and totals their durations
Assistant → control_playback(action="devices")
Assistant → control_playback(action="play", track_uris=[...], device_id="...")
Assistant checks verified=true and queue_complete=true in the play response

User: Save this as Midnight Coding.
Assistant → save_playlist(name="Midnight Coding", session_id="...")
```

Search results alone do not prove a track has no vocals or improves focus. Curation uses your preferences and available metadata. The server does not analyze audio, depend on Spotify Recommendations/Audio Features, run web research, or contain a second LLM. Your assistant can research separately if it has web tools.

## Local data and recovery

- Tokens stay in macOS Keychain under service `personal-spotify-mcp`, account = your Client ID. They are not written to project files or MCP responses. Expired access tokens refresh automatically; revoked credentials require login again.
- Keychain writes pass credentials through stdin to Apple's `security` helper, not command-line arguments. macOS may request permission to access Keychain.
- Track/session metadata is stored in `~/Library/Application Support/spotify-mcp/<client-id>/state.json`, with private file permissions and atomic replacement. The cache keeps the 1,000 most recent track records and 20 sessions; sessions embed their own track metadata.
- Override `SPOTIFY_MCP_DATA_DIR` to change the metadata directory. Override `SPOTIFY_REDIRECT_URI` for another explicit loopback port/path, and register that exact URI with Spotify.
- A `server.lock` prevents concurrent writers from separate assistant clients. Normal exit releases it. After a forced kill/crash, check the PID written in the lock; remove the lock only after verifying the process has stopped.
- Corrupt state is reported rather than overwritten. Back it up before repair/removal. Keep state if you want to retain saved-playlist mappings.
- Playlist filling uses Spotify's current `PUT /playlists/{id}/items` endpoint with at most 100 tracks. A checkpoint retains the created playlist ID before filling; retrying reuses it and replaces its contents safely.
- If creating a playlist times out, the remote outcome may be unknown. Do not blindly retry: inspect Spotify first. There is no atomic transaction between Spotify creation and the local checkpoint, so a crash in that gap can leave an untracked playlist. Once checkpointed, repeated saves reuse the playlist.
- Rate/quota errors include Retry-After when Spotify supplies it. Writes are not automatically retried after network/5xx failures. A 401 triggers one token refresh and retry.

## Scope and limitations

The audio plays in Spotify on your chosen device, not inside the chat. Spotify must be installed/open and discoverable. The assistant must match your Mac from the actual device list; the server does not equate an arbitrary active device with your Mac. Restricted devices are excluded.

The first version supports selections of at most 100 tracks, not an endless DJ queue. Duration is approximate, not a stop timer: Spotify autoplay/repeat settings can extend playback. Other Spotify clients can change playback independently. Server status reports Spotify's current state; the locally remembered session is the original curated selection.

### Playback speed and desktop compatibility

One play call now selects the device, inspects its prior state, activates it if needed, starts music, and verifies the first track on that device. It distinguishes a new start from stale state for the same song. HTTP success alone is never considered confirmed playback.

Spotify desktop can acknowledge a `uris` track-list start while clearing the player and playing nothing. If the normal start is not verified, the server resolves the first track's album, starts that album at the requested track, verifies it, and enqueues the remaining selection in order. Queue verification checks the requested prefix and avoids adding an already queued matching prefix. The server never retries an ambiguous enqueue automatically.

A successfully verified album fallback is remembered per device for seven days in local state, including across restarts. Subsequent plays bypass the failing track-list request. The normal route is tried again after that period. No playlist is created for this workaround. The album can continue after the requested queue ends.

Playback uses one shared **eight-second Spotify request budget**, covering discovery, activation, verification, fallback, and queue operations. Local disk work is outside that network budget. Large fallback selections may only be partly queued before the budget ends: `verified=true` indicates the first track was observed playing; only `queue_complete=true` confirms the full selection's queue was ready. An incomplete/unconfirmed response includes guidance and must not trigger blind play/enqueue retries or app restart loops.

Each play result includes `timing_ms.total`, `device_discovery`, and per-step timings. Valid tokens are cached in process memory to avoid a Keychain subprocess per API call; refresh still updates Keychain. No token is logged.

Live verification on this Mac: the silent track-list problem was reproduced; album-context playback recovered it. The final learned-path run verified playback and the four-track queue in **2,417 ms**. This is one observed run, not a latency guarantee; Spotify/network delays and queue size can change it. Already queued matching tracks were reused in that run.

Current OAuth scopes: `user-read-playback-state`, `user-modify-playback-state`, `playlist-modify-private`. No public-playlist, email, library, microphone, or separate AI API permissions are requested.

## Development

Use Node.js 22+ and pnpm. This workspace has a lockfile; dependency lifecycle scripts were disabled during installation.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm build
```

If Node/pnpm are absent from PATH in this Codex workspace:

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
```

Source layout: `auth.ts` (PKCE/Keychain/refresh), `spotify.ts` (API/device access), `store.ts` (persistent sessions), `app.ts` (workflow), `server.ts` (three MCP tools), `index.ts` (CLI/stdio). The v1 MCP SDK is pinned by the lockfile; v2 examples use different package names.

Automated checks use mocked Spotify/token responses and a real MCP client/server connection. They do not prove live Spotify account access, audible playback, or macOS Keychain/browser approval. Those require the login and live smoke test above.

To run the read-only live smoke test after login:

```sh
SPOTIFY_CLIENT_ID=YOUR_CLIENT_ID node scripts/check-connection.mjs
```

Local verification completed: browser login and Keychain storage, three-tool discovery, live search, device discovery (MacBook Pro), verified playback, album fallback, and the requested four-track queue. No playlist was created.

## API references

- [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server)
- [Spotify PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- [Spotify search](https://developer.spotify.com/documentation/web-api/reference/search)
- [Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)
- [Create playlist](https://developer.spotify.com/documentation/web-api/reference/create-playlist)
- [Replace playlist items](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items)
- [Development mode](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
