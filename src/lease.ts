import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// One writer per data directory, including across different MCP client apps.
export function acquireLease(directory: string): () => void {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const path = join(directory, 'server.lock');
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another Spotify MCP instance may be using this data directory. Close it first. If a crash left a stale lock, verify its PID is no longer running before removing ${path}.`);
    throw error;
  }
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  let released = false;
  return () => { if (!released) { released = true; unlinkSync(path); } };
}
