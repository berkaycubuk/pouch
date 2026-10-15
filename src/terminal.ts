// Finds Claude Code sessions that are open in another process (usually a terminal in tmux),
// using the per-process files Claude Code keeps in ~/.claude/sessions/<pid>.json.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TerminalInfo = {
  pid: number;
  busy: boolean;
  tmux?: string;
  name?: string;
};

const DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');

type SessionFile = {
  pid: number;
  sessionId: string;
  procStart?: string;
  status?: string;
  tmux?: string;
  name?: string;
};

// /proc/<pid>/stat fields after the "(comm)" part: state is [0], ppid [1], starttime [19].
async function procStat(pid: number): Promise<string[] | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

export async function terminalSessions(): Promise<Map<string, TerminalInfo>> {
  const out = new Map<string, TerminalInfo>();
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  await Promise.all(
    files.map(async (f) => {
      let s: SessionFile;
      try {
        s = JSON.parse(await readFile(join(DIR, f), 'utf8'));
      } catch {
        return;
      }
      if (!s.pid || !s.sessionId) return;
      const stat = await procStat(s.pid);
      if (!stat) return; // process gone, file is stale
      if (s.procStart && stat[19] !== s.procStart) return; // pid was reused
      if (Number(stat[1]) === process.pid) return; // our own SDK child
      out.set(s.sessionId, { pid: s.pid, busy: s.status === 'busy', tmux: s.tmux, name: s.name });
    }),
  );
  return out;
}
