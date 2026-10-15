// Interactive shells in a PTY, for running commands from the phone. They live in this process,
// so a restart (or deploy) ends them. Output is kept so a reconnecting client can replay it.
import { spawn, type IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { claudeEnv } from './settings.js';

const KEEP = 256 * 1024; // chars of output replayed to a client that attaches

export type ShellInfo = { id: string; cwd: string; created: number; process: string };

type Client = { send(data: string): void };

type Shell = { id: string; cwd: string; created: number; pty: IPty; output: string; clients: Set<Client> };

export class ShellManager {
  private shells = new Map<string, Shell>();

  constructor(private onChange: () => void) {}

  list(): ShellInfo[] {
    return [...this.shells.values()].map((s) => ({ id: s.id, cwd: s.cwd, created: s.created, process: s.pty.process }));
  }

  create(cwd: string): string {
    // NO_TMUX: a .bashrc that auto-attaches tmux would otherwise put every terminal here into the same
    // tmux session as the desktop's, typing into whatever is open there.
    const env = claudeEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_TMUX: '1' });
    const pty = spawn(process.env.SHELL || 'bash', ['-l'], { name: 'xterm-256color', cwd, cols: 80, rows: 24, env });
    const s: Shell = { id: randomUUID(), cwd, created: Date.now(), pty, output: '', clients: new Set() };
    pty.onData((d) => {
      s.output = (s.output + d).slice(-KEEP);
      const msg = JSON.stringify({ o: d });
      for (const c of s.clients) c.send(msg);
    });
    pty.onExit(({ exitCode }) => {
      const msg = JSON.stringify({ exit: exitCode });
      for (const c of s.clients) c.send(msg);
      this.shells.delete(s.id);
      this.onChange();
    });
    this.shells.set(s.id, s);
    this.onChange();
    return s.id;
  }

  // Returns false if the shell is gone. Sends {replay}, then {o: output} and {exit}; takes {i: input} and {cols, rows}.
  attach(id: string, client: Client & { on(ev: 'message' | 'close', fn: (data?: unknown) => void): void }) {
    const s = this.shells.get(id);
    if (!s) return false;
    s.clients.add(client);
    client.send(JSON.stringify({ replay: s.output }));
    client.on('message', (data) => {
      let m: { i?: unknown; cols?: unknown; rows?: unknown };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof m.i === 'string') s.pty.write(m.i);
      const { cols, rows } = m;
      if (Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) > 0 && (rows as number) > 0) {
        s.pty.resize(Math.min(cols as number, 500), Math.min(rows as number, 200));
      }
    });
    client.on('close', () => s.clients.delete(client));
    return true;
  }

  kill(id: string) {
    this.shells.get(id)?.pty.kill('SIGHUP');
  }
}
