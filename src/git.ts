// Git queries for the Changes and project screens. The writes: worktrees, cloning, init and fast-forward pulls.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';

const run = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF = 300_000;

export type ChangedFile = { path: string; added: number; removed: number; status: 'modified' | 'added' | 'deleted' | 'untracked' | 'binary' };
export type Changes = { git: false } | { git: true; branch: string; files: ChangedFile[] };

async function git(cwd: string, args: string[], okCodes = [0]) {
  try {
    const { stdout } = await run('git', ['-C', cwd, '--no-pager', ...args], { maxBuffer: 20 * 1024 * 1024, timeout: 15_000 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (typeof e.code === 'number' && okCodes.includes(e.code)) return e.stdout ?? '';
    throw err;
  }
}

async function base(cwd: string) {
  try {
    await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
    return 'HEAD';
  } catch {
    return EMPTY_TREE; // repo without commits yet
  }
}

export async function changes(cwd: string): Promise<Changes> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { git: false };
  }
  const head = await base(cwd);
  const [branch, numstat, nameStatus, untracked] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '(no commits)'),
    git(cwd, ['diff', head, '--numstat', '-z']),
    git(cwd, ['diff', head, '--name-status', '-z']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const statusOf = new Map<string, string>();
  const ns = nameStatus.split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) statusOf.set(ns[i + 1], ns[i]);

  const files: ChangedFile[] = [];
  for (const rec of numstat.split('\0').filter(Boolean)) {
    const [a, r, path] = rec.split('\t');
    if (!path) continue; // renames use a multi-field form; not produced without -M
    const st = statusOf.get(path);
    files.push({
      path,
      added: Number(a) || 0,
      removed: Number(r) || 0,
      status: a === '-' ? 'binary' : st === 'A' ? 'added' : st === 'D' ? 'deleted' : 'modified',
    });
  }
  for (const path of untracked.split('\0').filter(Boolean)) {
    files.push({ path, added: 0, removed: 0, status: 'untracked' });
  }
  return { git: true, branch: branch.trim(), files };
}

export async function fileDiff(cwd: string, path: string): Promise<string> {
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', path]).then(() => true, () => false);
  const out = tracked
    ? await git(cwd, ['diff', await base(cwd), '--', path])
    : await git(cwd, ['diff', '--no-index', '--', '/dev/null', path], [0, 1]);
  return out.length > MAX_DIFF ? out.slice(0, MAX_DIFF) + '\n… (diff truncated)' : out;
}

export type RepoStatus = { branch: string; changed: number; ahead?: number; behind?: number };

/** Branch, uncommitted file count, and ahead/behind the upstream as of the last fetch (no network). */
export async function repoStatus(cwd: string): Promise<RepoStatus | null> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  const [branch, porcelain, counts] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '(no commits)'),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => ''),
  ]);
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return {
    branch: branch.trim(),
    changed: porcelain.split('\n').filter(Boolean).length,
    ...(counts.trim() ? { ahead, behind } : {}),
  };
}

export type PullRequest = { number: number; title: string; url: string; headRefName: string; isDraft: boolean; reviewDecision: string };

/** Open PRs via the gh CLI; empty when gh is missing, unauthenticated, or the repo has no GitHub remote. */
export async function openPRs(cwd: string): Promise<PullRequest[]> {
  try {
    const { stdout } = await run('gh', ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,url,headRefName,isDraft,reviewDecision'], { cwd, timeout: 15_000 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export type MergedPR = { number: number; headRefName: string; headRefOid: string };

/** Recently merged PRs via the gh CLI; empty when gh can't answer. */
export async function mergedPRs(cwd: string): Promise<MergedPR[]> {
  try {
    const { stdout } = await run('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'number,headRefName,headRefOid'], { cwd, timeout: 15_000 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export type Worktree = { path: string; branch?: string; head?: string };

/** Linked worktrees of the repo at `cwd`, excluding the main checkout. */
export async function worktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']).catch(() => '');
  return out.split('\n\n').filter(Boolean).slice(1).flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    const head = block.match(/^HEAD (\w+)$/m)?.[1];
    return path && !/^prunable/m.test(block) ? [{ path, branch, head }] : [];
  });
}

const slug = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 4).join('-').slice(0, 40).replace(/-$/, '') || 'task';

/** Create `../<repo>-<branch>` on a new branch off the remote default branch. Returns its path. */
export async function addWorktree(repo: string, prompt: string): Promise<string> {
  await git(repo, ['fetch', '--quiet', 'origin']).catch(() => {}); // offline or no remote: branch off what we have
  const start = (await git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => 'HEAD')).trim();
  const taken = async (b: string) =>
    existsSync(join(dirname(repo), `${basename(repo)}-${b}`)) ||
    (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).then(() => true, () => false));
  let branch = slug(prompt);
  for (let i = 2; await taken(branch); i++) branch = `${slug(prompt)}-${i}`;
  const path = join(dirname(repo), `${basename(repo)}-${branch}`);
  await git(repo, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, start]); // no upstream: a bare `git push` mustn't target main
  return path;
}

/** Fails on uncommitted changes unless forced. Keeps the branch: it may have a PR. */
export async function removeWorktree(repo: string, path: string, force: boolean) {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}

/** For a worktree whose PR was merged at exactly its tip, so the branch's commits are on GitHub. Fails on uncommitted changes. */
export async function removeMergedWorktree(repo: string, w: Worktree) {
  await git(repo, ['worktree', 'remove', w.path]);
  if (w.branch) await git(repo, ['branch', '-D', w.branch]);
}

// Never wait on a credential prompt: there's no terminal to answer it.
const noPrompt = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/** `owner/repo` is shorthand for GitHub over https (gh is the credential helper). Only https and ssh, so no ext:: or file:// tricks. */
export function cloneUrl(input: string): string | null {
  const s = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, '')}.git`;
  if (/^(https|ssh):\/\/[^\s]+$/.test(s) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(s)) return s;
  return null;
}

export async function cloneRepo(url: string, dest: string) {
  await run('git', ['clone', '--quiet', '--', url, dest], { env: noPrompt, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 });
}

export async function initRepo(dir: string) {
  await git(dir, ['init', '--quiet', '-b', 'main']);
}

/** Fast-forward only, so it never makes a merge commit or leaves conflicts behind. */
export async function pull(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, 'pull', '--ff-only'], { env: noPrompt, timeout: 120_000 });
  return stdout.trim();
}

export type Branch = { name: string; remote?: boolean; current?: boolean; worktree?: string; date: number; default?: boolean; merged?: boolean };

/**
 * Local branches, plus origin's unmerged branches that have no local copy yet. Current first, then newest commit. Fetches first, best effort.
 * `merged`: a local branch whose commits are all in origin's default branch, or whose upstream is gone (GitHub deletes it after a merge).
 */
export async function branches(cwd: string, fetch = true): Promise<Branch[]> {
  if (fetch) await run('git', ['-C', cwd, 'fetch', '--quiet', '--prune', 'origin'], { env: noPrompt, timeout: 20_000 }).catch(() => {});
  const [out, main] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(refname)%09%(HEAD)%09%(worktreepath)%09%(committerdate:unix)%09%(upstream:track)', 'refs/heads', 'refs/remotes/origin']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).then((s) => s.trim(), () => ''),
  ]);
  const merged = new Set(main ? (await git(cwd, ['for-each-ref', '--format=%(refname)', '--merged', main, 'refs/heads', 'refs/remotes/origin']).catch(() => '')).split('\n') : []);
  const local = new Set<string>();
  const list: Branch[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, head, wt, date, track] = line.split('\t');
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      local.add(name);
      const isDefault = name === main.slice('origin/'.length);
      list.push({
        name, date: Number(date),
        ...(head === '*' ? { current: true } : wt && wt !== cwd ? { worktree: wt } : {}),
        ...(isDefault ? { default: true } : merged.has(ref) || track === '[gone]' ? { merged: true } : {}),
      });
    } else {
      const name = ref.slice('refs/remotes/origin/'.length);
      if (name !== 'HEAD' && !merged.has(ref)) list.push({ name, remote: true, date: Number(date) }); // merged: nothing new to switch to
    }
  }
  return list.filter((b) => !b.remote || !local.has(b.name)).sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.date - a.date);
}

/** Refuses with uncommitted changes to tracked files rather than carrying them over. A remote-only branch gets a local tracking copy. */
export async function switchBranch(cwd: string, b: Branch) {
  if ((await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Commit or stash your uncommitted changes first');
  await git(cwd, ['switch', '--quiet', ...(b.remote ? ['--track', `origin/${b.name}`] : [b.name])]);
}

/** Unless forced, refuses a branch that isn't merged, saying whether its commits exist anywhere else. */
export async function deleteBranch(cwd: string, b: Branch, force: boolean) {
  if (!b.merged && !force) {
    const n = Number((await git(cwd, ['rev-list', '--count', `refs/heads/${b.name}`, '--not', '--remotes'])).trim()) || 0;
    throw new Error(n
      ? `${b.name} isn't merged and has ${n > 1 ? `${n} commits that aren't` : "a commit that isn't"} pushed anywhere. ${n > 1 ? "They'll" : "It'll"} be lost.`
      : `${b.name} isn't merged, but its commits are pushed.`);
  }
  await git(cwd, ['branch', '-D', b.name]);
}

/** Commits on local branches that no remote has (all of them when there's no remote), and stash entries. */
export async function unpushed(repo: string): Promise<{ commits: number; stashes: number }> {
  const [commits, stashes] = await Promise.all([
    git(repo, ['rev-list', '--count', '--branches', '--not', '--remotes']).catch(() => '0'),
    git(repo, ['stash', 'list']).catch(() => ''),
  ]);
  return { commits: Number(commits.trim()) || 0, stashes: stashes.split('\n').filter(Boolean).length };
}
