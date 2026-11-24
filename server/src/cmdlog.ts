// Append-only command log under the server data dir. Records who/what/when, never prompt text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir(): string {
  const o = process.env.CR_DATA_DIR;
  return o && o.trim() !== '' ? o : path.join(os.homedir(), '.claude-control-room');
}

/** Scratch folder the Haiku helper runs in; the watcher ignores sessions started there. */
export function summarizerDir(): string {
  return path.join(dataDir(), 'summarizer');
}

export type LogFn = (entry: Record<string, unknown>) => void;

export function fileLogger(dir: string = dataDir(), now: () => number = Date.now): LogFn {
  const file = path.join(dir, 'commands.log');
  let ready = false;
  return (entry) => {
    try {
      if (!ready) {
        fs.mkdirSync(dir, { recursive: true });
        ready = true;
      }
      fs.appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      // logging must never break a command
    }
  };
}
