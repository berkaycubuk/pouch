import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { lstat, mkdir, readdir, readFile, rm, statfs } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, homedir, loadavg } from 'node:os';
import { isIP } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager, InUseError, type Decision } from './sessions.js';
import { ShellManager } from './shells.js';
import { changes, fileDiff, repoStatus, openPRs, mergedPRs, worktrees, addWorktree, removeWorktree, removeMergedWorktree, cloneUrl, cloneRepo, initRepo, pull, unpushed, branches, switchBranch, deleteBranch } from './git.js';
import { Push } from './push.js';
import { loadToken, authorized, validToken, setLoginCookie, startPairing, pairingInfo, approvePairing, claimPairing } from './auth.js';
import { accessEnabled, accessJwt, validAccessJwt, viaCloudflare } from './access.js';
import { checkImages, type ImageInput } from './events.js';
import { mcpServers } from './mcp.js';
import { loadSettings, settings, updateSettings, loadChatSettings, chatSettings } from './settings.js';

const HOST = process.env.POUCH_HOST ?? '127.0.0.1';
const PORT = Number(process.env.POUCH_PORT ?? 8787);
const PROJECTS_DIR = process.env.POUCH_PROJECTS ?? join(homedir(), 'Projects');
const EXTRA_HOSTS = (process.env.POUCH_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const root = resolve(fileURLToPath(import.meta.url), '../..');

// The importmap has to be inline, so the CSP allows it by hash.
const indexHtml = readFileSync(join(root, 'web/index.html'), 'utf8');
const importmap = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '';
const importmapHash = createHash('sha256').update(importmap).digest('base64');

// app.js and style.css get a per-deploy ?v=, so phones can't keep running an old app.js from a cache
// (Cloudflare's browser cache TTL can stretch the max-age=0 the static files send).
const assetVersion = createHash('sha256').update(readFileSync(join(root, 'web/app.js'))).update(readFileSync(join(root, 'web/style.css'))).digest('hex').slice(0, 12);
const page = indexHtml.replace(/(href|src)="\/(app\.js|style\.css)"/g, `$1="/$2?v=${assetVersion}"`);

const app = Fastify({ logger: { level: 'warn' } });
// Routes that accept image attachments (base64 in JSON) need a larger body than the 1 MB default.
const withImages = { bodyLimit: 60 * 1024 * 1024 };
// Anything that reaches the API can run commands, so refuse what a web page could forge:
// a Host that isn't ours (DNS rebinding) or a cross-site Origin (CSRF, reading /ws from another site).
// No Origin means a non-browser client, which could reach the API anyway.
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
const allowedHost = (host = '') => {
  const name = hostname(host);
  return name === 'localhost' || isIP(name) !== 0 || name.endsWith('.ts.net') || EXTRA_HOSTS.includes(name);
};
// Reachable without a login: the token login and the new-device half of QR login.
const OPEN_ROUTES = new Set(['/api/login', '/api/pair', '/api/pair/claim']);

const sameOrigin = (origin: string, host: string) => {
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
};
app.addHook('onRequest', async (req, reply) => {
  const { host = '', origin } = req.headers;
  // tailscale serve passes the public name in X-Forwarded-Host.
  const fwd = req.headers['x-forwarded-host'];
  const publicHost = (Array.isArray(fwd) ? fwd[0] : fwd) ?? host;
  if (!allowedHost(host)) return reply.code(403).send({ error: 'host not allowed; add it to POUCH_HOSTS' });
  // Through the Cloudflare tunnel, everything (page included) needs a valid Access JWT. Without Access
  // configured, tunnel traffic is refused outright rather than left to the token alone.
  if (viaCloudflare(req) && !(accessEnabled && (await validAccessJwt(accessJwt(req))))) {
    return reply.code(403).send({ error: 'Cloudflare Access login required' });
  }
  // img-src leaves out remote URLs, so Markdown images can't leak anything to other hosts.
  reply.headers({
    'content-security-policy': [
      "default-src 'self'", `script-src 'self' 'sha256-${importmapHash}'`, "img-src 'self' data: blob:",
      // xterm.js (terminal screen) writes its layout and theme into <style> elements.
      "style-src 'self' 'unsafe-inline'", `connect-src 'self' ws://${publicHost} wss://${publicHost}`, "object-src 'none'", "base-uri 'none'",
      "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  if (origin !== undefined && !sameOrigin(origin, publicHost)) return reply.code(403).send({ error: 'cross-origin request refused' });
  // By matched route, not raw URL, so odd paths can't slip past. The page, vendor files and login stay open.
  const route = req.routeOptions.url ?? '';
  if ((route.startsWith('/api/') || route === '/ws') && !OPEN_ROUTES.has(route) && !authorized(req)) {
    return reply.code(401).send({ error: 'login required' });
  }
});
await app.register(fastifyWebsocket);
// no-cache: always revalidate (a cheap 304 when nothing changed).
await app.register(fastifyStatic, { root: join(root, 'web'), index: false, cacheControl: false, setHeaders: (res) => res.header('cache-control', 'no-cache') });
const sendPage = (_req: unknown, reply: FastifyReply) => reply.type('text/html').header('cache-control', 'no-cache').send(page);
app.get('/', sendPage);
app.get('/index.html', sendPage);

const sockets = new Set<{ send(data: string): void }>();
const push = new Push();
await push.init();
await loadToken();
await loadSettings();
await loadChatSettings();
const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg);
  for (const ws of sockets) ws.send(data);
};
// Push is skipped while the app is in front (see sw.js), so open apps get the same note as a toast.
const sessions = new SessionManager(broadcast, (n) => {
  broadcast({ type: 'notify', notification: n });
  void push.send(n);
});
const shells = new ShellManager(() => broadcast({ type: 'shells', shells: shells.list() }));

// Browser ESM builds served straight from node_modules, so the frontend needs no build step.
const vendor: Record<string, string> = {
  'preact.mjs': 'preact/dist/preact.mjs',
  'hooks.mjs': 'preact/hooks/dist/hooks.mjs',
  'htm.mjs': 'htm/dist/htm.module.js',
  'marked.mjs': 'marked/lib/marked.esm.js',
  'purify.mjs': 'dompurify/dist/purify.es.mjs',
  'xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  'addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  'uqr.mjs': 'uqr/dist/index.mjs',
  'jsqr.mjs': 'jsqr-es6/dist/jsQR.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
};
app.get<{ Params: { file: string } }>('/vendor/:file', (req, reply) => {
  const path = vendor[req.params.file];
  if (!path) return reply.code(404).send();
  reply.type(path.endsWith('.css') ? 'text/css' : 'text/javascript').header('cache-control', 'max-age=86400');
  return reply.send(createReadStream(join(root, 'node_modules', path)));
});

app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// A linked worktree has a .git file pointing into its main repo: "gitdir: <main>/.git/worktrees/<name>".
async function gitKind(path: string): Promise<{ git: boolean; worktreeOf?: string }> {
  const dotgit = await readFile(join(path, '.git'), 'utf8').catch((e) => (e.code === 'EISDIR' ? 'dir' : null));
  if (dotgit === null) return { git: false };
  return { git: true, worktreeOf: dotgit.match(/^gitdir: (.+)\/\.git\/worktrees\//m)?.[1] };
}

async function projectDirs() {
  const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  return Promise.all(entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map(async (e) => {
      const path = join(PROJECTS_DIR, e.name);
      return { name: e.name, path, ...(await gitKind(path)) };
    }));
}

const inside = (cwd: string, dirs: string[]) => dirs.some((d) => cwd === d || cwd.startsWith(d + '/'));

// Worktrees are folded into their main repo. Most recently used first, by the newest session in the project.
app.get('/api/projects', async () => {
  const [dirs, list] = await Promise.all([projectDirs(), sessions.list()]);
  const mains = new Set(dirs.map((d) => d.path));
  return dirs
    .filter((d) => !d.worktreeOf || !mains.has(d.worktreeOf))
    .map(({ worktreeOf, ...p }) => {
      const paths = [p.path, ...dirs.filter((d) => d.worktreeOf === p.path).map((d) => d.path)];
      const mine = list.filter((s) => inside(s.cwd, paths));
      return {
        ...p,
        worktrees: paths.length - 1,
        lastActivity: Math.max(0, ...mine.map((s) => s.lastActivity)),
        active: mine.filter((s) => s.live || s.terminal).length,
      };
    })
    .sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
});

// Only names that are actual project directories; never a client-supplied path.
const findProject = async (name: string) => (await projectDirs()).find((p) => p.name === name);

app.get<{ Params: { name: string } }>('/api/projects/:name', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p) return reply.code(404).send({ error: 'not found' });
  const wts = p.git ? await worktrees(p.path) : [];
  const [git, list, wtGit] = await Promise.all([
    repoStatus(p.path),
    sessions.list(p.path, wts.map((w) => w.path)),
    Promise.all(wts.map((w) => repoStatus(w.path))),
  ]);
  return { ...p, git, sessions: list, worktrees: wts.map((w, i) => ({ ...w, name: basename(w.path), git: wtGit[i] })) };
});

// Separate from the project itself because gh goes over the network and can be slow.
app.get<{ Params: { name: string } }>('/api/projects/:name/prs', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p) return reply.code(404).send({ error: 'not found' });
  return openPRs(p.path);
});

app.post<{ Params: { name: string }; Body: { path: string; force?: boolean } }>('/api/projects/:name/worktrees/remove', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p) return reply.code(404).send({ error: 'not found' });
  const { path, force = false } = req.body ?? {};
  if (!(await worktrees(p.path)).some((w) => w.path === path)) return reply.code(404).send({ error: 'not a worktree of this project' });
  const busy = (await sessions.list(p.path, [path])).some((s) => (s.live || s.terminal) && inside(s.cwd, [path]));
  if (busy) return reply.code(409).send({ error: 'A session is still open in this worktree' });
  if (shells.list().some((s) => inside(s.cwd, [path]))) return reply.code(409).send({ error: 'A terminal is still open in this worktree' });
  try {
    await removeWorktree(p.path, path, force === true);
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? '';
    if (!force && /modified or untracked/.test(msg)) return reply.code(409).send({ error: 'It has uncommitted changes', dirty: true });
    return reply.code(500).send({ error: msg.trim() || (err as Error).message });
  }
  return { ok: true };
});

// Removes a worktree (and its branch) once its PR is merged, but only while its tip is still the merged PR's head: a
// follow-up commit, uncommitted file, open session or terminal keeps it. Only worktrees in the projects folder.
async function sweepMergedWorktrees() {
  const dirs = (await projectDirs().catch(() => [])).filter((d) => d.git && !d.worktreeOf);
  for (const p of dirs) {
    const wts = (await worktrees(p.path)).filter((w) => w.branch && w.head && inside(w.path, [resolve(PROJECTS_DIR)]) && !inside(root, [w.path]));
    if (!wts.length) continue;
    const merged = await mergedPRs(p.path);
    const done = wts.filter((w) => merged.some((pr) => pr.headRefName === w.branch && pr.headRefOid === w.head));
    if (!done.length) continue;
    const open = (await sessions.list(p.path, done.map((w) => w.path))).filter((s) => s.live || s.terminal);
    let removed = 0;
    for (const w of done) {
      if (open.some((s) => inside(s.cwd, [w.path])) || shells.list().some((s) => inside(s.cwd, [w.path]))) continue;
      try {
        await removeMergedWorktree(p.path, w);
        removed++;
        console.log(`removed merged worktree ${w.path}`);
      } catch (err) {
        const msg = gitError(err);
        if (!/modified or untracked/.test(msg)) console.warn(`could not remove merged worktree ${w.path}: ${msg}`);
      }
    }
    if (removed) broadcast({ type: 'worktrees', project: p.name });
  }
}
setTimeout(function sweep() {
  void sweepMergedWorktrees().catch((err) => console.warn('merged worktree sweep failed:', err)).finally(() => setTimeout(sweep, 10 * 60_000).unref());
}, 60_000).unref();

const gitError = (err: unknown) => ((err as { stderr?: string }).stderr ?? '').trim() || (err as Error).message;

// Clone `url` into the projects directory, or make an empty project (optionally a git repo) when there's no url.
app.post<{ Body: { name?: string; url?: string; git?: boolean } }>('/api/projects', async (req, reply) => {
  const { url: input, git = true } = req.body ?? {};
  const url = input ? cloneUrl(input) : undefined;
  if (url === null) return reply.code(400).send({ error: 'Use an https or ssh git URL, or owner/repo for GitHub' });
  const name = (req.body?.name?.trim() || (url && basename(url).replace(/\.git$/, '')) || '');
  if (!/^\w[\w.-]*$/.test(name)) return reply.code(400).send({ error: 'Name may only use letters, digits, ., _ and -' });
  const dest = join(PROJECTS_DIR, name);
  if (existsSync(dest)) return reply.code(409).send({ error: `${name} already exists` });
  try {
    if (url) await cloneRepo(url, dest);
    else {
      await mkdir(dest);
      if (git) await initRepo(dest);
    }
  } catch (err) {
    return reply.code(500).send({ error: gitError(err) });
  }
  return { name };
});

app.post<{ Params: { name: string } }>('/api/projects/:name/pull', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p?.git) return reply.code(404).send({ error: 'not a git project' });
  try {
    return { output: await pull(p.path) };
  } catch (err) {
    return reply.code(409).send({ error: gitError(err) });
  }
});

app.get<{ Params: { name: string } }>('/api/projects/:name/branches', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p?.git) return reply.code(404).send({ error: 'not a git project' });
  return branches(p.path);
});

// Only branches git listed; never a client-supplied ref.
app.post<{ Params: { name: string }; Body: { branch?: string; remote?: boolean } }>('/api/projects/:name/switch', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p?.git) return reply.code(404).send({ error: 'not a git project' });
  const { branch, remote = false } = req.body ?? {};
  const b = (await branches(p.path, false)).find((x) => x.name === branch && !!x.remote === remote);
  if (!b) return reply.code(404).send({ error: 'no such branch' });
  if (b.worktree) return reply.code(409).send({ error: `${b.name} is checked out in ${basename(b.worktree)}` });
  try {
    await switchBranch(p.path, b);
  } catch (err) {
    return reply.code(409).send({ error: gitError(err) });
  }
  return { ok: true };
});

// Local branches only: deleting on origin is GitHub's job (it can delete a PR's branch on merge).
app.post<{ Params: { name: string }; Body: { branch?: string; force?: boolean } }>('/api/projects/:name/branches/delete', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p?.git) return reply.code(404).send({ error: 'not a git project' });
  const { branch, force = false } = req.body ?? {};
  const b = (await branches(p.path, false)).find((x) => x.name === branch && !x.remote);
  if (!b) return reply.code(404).send({ error: 'no such branch' });
  if (b.current || b.worktree) return reply.code(409).send({ error: `${b.name} is checked out${b.worktree ? ` in ${basename(b.worktree)}` : ''}` });
  if (b.default) return reply.code(409).send({ error: `${b.name} is the default branch` });
  try {
    await deleteBranch(p.path, b, force);
  } catch (err) {
    return reply.code(409).send({ error: gitError(err) });
  }
  return { ok: true };
});

// What deleting a project would take with it. Blockers refuse the delete; risks are shown before confirming.
async function deletePlan(p: { name: string; path: string; git: boolean }) {
  const wts = p.git ? await worktrees(p.path) : [];
  const paths = [p.path, ...wts.map((w) => w.path)];
  const blockers: string[] = [];
  const risks: string[] = [];
  const list = await sessions.list(p.path, wts.map((w) => w.path));
  const open = list.filter((s) => (s.live || s.terminal) && inside(s.cwd, paths)).length;
  if (open) blockers.push(`${open} session${open > 1 ? 's are' : ' is'} still open here. End ${open > 1 ? 'them' : 'it'} first.`);
  const terms = shells.list().filter((s) => inside(s.cwd, paths)).length;
  if (terms) blockers.push(`${terms} terminal${terms > 1 ? 's are' : ' is'} still open here. Close ${terms > 1 ? 'them' : 'it'} first.`);
  if (inside(root, paths) || inside(process.cwd(), paths)) blockers.push('pouch itself runs from here.');
  const projects = resolve(PROJECTS_DIR);
  for (const w of wts) {
    if (!inside(resolve(w.path), [projects])) blockers.push(`Worktree ${w.path} is outside the projects folder. Remove it first.`);
  }
  if (!p.git) risks.push('Not a git repo: nothing here is backed up anywhere.');
  else {
    const [{ commits, stashes }, statuses] = await Promise.all([unpushed(p.path), Promise.all(paths.map(repoStatus))]);
    if (commits) risks.push(`${commits} commit${commits > 1 ? 's' : ''} not on any remote`);
    if (stashes) risks.push(`${stashes} stash${stashes > 1 ? 'es' : ''}`);
    statuses.forEach((g, i) => {
      if (g?.changed) risks.push(`${g.changed} uncommitted file${g.changed > 1 ? 's' : ''} in ${basename(paths[i])}`);
    });
    if (wts.length) risks.push(`Worktree${wts.length > 1 ? 's' : ''} ${wts.map((w) => basename(w.path)).join(', ')} (deleted with it)`);
  }
  return { paths, blockers, risks };
}

app.get<{ Params: { name: string } }>('/api/projects/:name/delete', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p) return reply.code(404).send({ error: 'not found' });
  const { blockers, risks } = await deletePlan(p);
  return { blockers, risks };
});

// The body repeats the name, so a stray request can't delete anything. Session transcripts are kept.
app.post<{ Params: { name: string }; Body: { confirm?: string } }>('/api/projects/:name/delete', async (req, reply) => {
  const p = await findProject(req.params.name);
  if (!p) return reply.code(404).send({ error: 'not found' });
  if (req.body?.confirm !== p.name) return reply.code(400).send({ error: 'Type the project name to confirm' });
  const { paths, blockers } = await deletePlan(p);
  if (blockers.length) return reply.code(409).send({ error: blockers.join(' ') });
  try {
    // Worktrees first, so the main repo is never left pointing at half-deleted ones.
    for (const path of [...paths.slice(1), p.path]) {
      if ((await lstat(path).catch(() => null))?.isDirectory()) await rm(path, { recursive: true });
    }
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
  return { ok: true };
});

app.post<{ Body: { token?: string } }>('/api/login', async (req, reply) => {
  if (!validToken(req.body?.token)) return reply.code(401).send({ error: 'wrong token' });
  setLoginCookie(req, reply);
  return { ok: true };
});

// QR login, see startPairing. Starting and claiming are open; looking up and approving need a login.
app.post('/api/pair', (req, reply) => startPairing(req) ?? reply.code(429).send({ error: 'Too many logins in progress, try again in a few minutes' }));

app.post<{ Body: { code?: string; claim?: string } }>('/api/pair/claim', (req, reply) => {
  const r = claimPairing(String(req.body?.code ?? ''), req.body?.claim);
  if (r === 'gone') return reply.code(410).send({ error: 'This QR code expired' });
  if (r === 'ok') setLoginCookie(req, reply);
  return { ok: r === 'ok' };
});

app.get<{ Params: { code: string } }>('/api/pair/:code', (req, reply) =>
  pairingInfo(req.params.code) ?? reply.code(404).send({ error: 'This QR code expired or was already used' }));

app.post<{ Params: { code: string } }>('/api/pair/:code/approve', (req, reply) =>
  approvePairing(req.params.code) ? { ok: true } : reply.code(404).send({ error: 'This QR code expired or was already used' }));

app.get('/api/sessions', () => sessions.list());

app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const d = await sessions.detail(req.params.id);
  return d ?? reply.code(404).send({ error: 'not found' });
});

app.post<{ Body: { cwd: string; prompt: string; images?: ImageInput[]; worktree?: boolean } }>('/api/sessions', withImages, async (req, reply) => {
  const { cwd, prompt = '', images, worktree } = req.body ?? {};
  if (!cwd || (!prompt.trim() && !images?.length)) return reply.code(400).send({ error: 'cwd and prompt required' });
  const bad = checkImages(images);
  if (bad) return reply.code(400).send({ error: bad });
  const projects = resolve(PROJECTS_DIR);
  if (resolve(cwd) !== projects && !resolve(cwd).startsWith(projects + '/')) {
    return reply.code(400).send({ error: 'cwd must be inside the projects directory' });
  }
  let dir = resolve(cwd);
  if (worktree) {
    if (!(await projectDirs()).some((d) => d.path === dir && d.git)) return reply.code(400).send({ error: 'worktree needs a git project' });
    try {
      dir = await addWorktree(dir, prompt);
    } catch (err) {
      return reply.code(500).send({ error: `Could not create worktree: ${(err as Error).message}` });
    }
  }
  return { id: await sessions.create(dir, prompt.trim(), images) };
});

app.post<{ Params: { id: string }; Body: { text?: string; force?: boolean; images?: ImageInput[] } }>('/api/sessions/:id/message', withImages, async (req, reply) => {
  const { text = '', images, force } = req.body ?? {};
  if (!text.trim() && !images?.length) return reply.code(400).send({ error: 'text required' });
  const bad = checkImages(images);
  if (bad) return reply.code(400).send({ error: bad });
  try {
    await sessions.send(req.params.id, text.trim(), force === true, images);
  } catch (err) {
    if (err instanceof InUseError) return reply.code(409).send({ error: err.message, terminal: err.terminal });
    throw err;
  }
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/api/sessions/:id/changes', async (req, reply) => {
  const cwd = await sessions.cwdOf(req.params.id);
  if (!cwd) return reply.code(404).send({ error: 'not found' });
  return { cwd, ...(await changes(cwd)) };
});

app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/diff', async (req, reply) => {
  const cwd = await sessions.cwdOf(req.params.id);
  if (!cwd) return reply.code(404).send({ error: 'not found' });
  // Only diff paths git itself reported as changed; never an arbitrary path from the client.
  const c = await changes(cwd);
  if (!c.git || !c.files.some((f) => f.path === req.query.path)) return reply.code(404).send({ error: 'not a changed file' });
  return { diff: await fileDiff(cwd, req.query.path) };
});

app.post<{ Params: { id: string }; Body: { requestId: string; decision: Decision; answers?: Record<string, string> } }>(
  '/api/sessions/:id/respond',
  async (req) => {
    const { requestId, decision, answers } = req.body;
    sessions.respond(req.params.id, requestId, decision, answers);
    return { ok: true };
  },
);

app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req) => {
  await sessions.interrupt(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/tasks/:taskId/stop', async (req) => {
  await sessions.stopTask(req.params.id, req.params.taskId);
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/end', async (req) => {
  sessions.end(req.params.id);
  return { ok: true };
});

// Byte counts for the dashboard's stats strip. Memory "used" excludes cache, as `free` reports it.
app.get('/api/system', async () => {
  const kb = Object.fromEntries((await readFile('/proc/meminfo', 'utf8')).split('\n')
    .map((l) => l.match(/^(\w+):\s+(\d+)/)).filter((m) => m !== null).map((m) => [m[1], Number(m[2]) * 1024]));
  const fs = await statfs(homedir());
  return {
    load: loadavg()[0],
    cpus: cpus().length,
    mem: { used: kb.MemTotal - kb.MemAvailable, total: kb.MemTotal },
    swap: { used: kb.SwapTotal - kb.SwapFree, total: kb.SwapTotal },
    // As `df` counts it: blocks reserved for root are neither used nor available.
    disk: { used: (fs.blocks - fs.bfree) * fs.bsize, total: (fs.blocks - fs.bfree + fs.bavail) * fs.bsize },
  };
});

app.get('/api/shells', () => shells.list());

app.post<{ Body: { cwd?: string } }>('/api/shells', async (req, reply) => {
  const { cwd } = req.body ?? {};
  const dir = resolve(cwd ?? '');
  const projects = resolve(PROJECTS_DIR);
  if (!cwd || (dir !== projects && !dir.startsWith(projects + '/'))) return reply.code(400).send({ error: 'cwd must be inside the projects directory' });
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) return reply.code(400).send({ error: 'no such directory' });
  return { id: shells.create(dir) };
});

app.post<{ Params: { id: string } }>('/api/shells/:id/kill', async (req) => {
  shells.kill(req.params.id);
  return { ok: true };
});

// Under /api/ so the login check covers it.
app.get<{ Params: { id: string } }>('/api/shells/:id/ws', { websocket: true }, (socket, req) => {
  if (!shells.attach(req.params.id, socket)) {
    socket.send(JSON.stringify({ gone: true }));
    socket.close();
  }
});

app.get('/api/settings', () => settings());

app.post('/api/settings', (req) => updateSettings(req.body));

app.get<{ Querystring: { refresh?: string } }>('/api/mcp', (req) => mcpServers(req.query.refresh === '1'));

app.get<{ Params: { id: string } }>('/api/sessions/:id/settings', (req) => ({ app: settings(), chat: chatSettings(req.params.id) }));

app.post<{ Params: { id: string }; Body: { title?: string } & Record<string, unknown> }>('/api/sessions/:id/settings', async (req, reply) => {
  const { title, ...patch } = req.body ?? {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'title required' });
    await sessions.rename(req.params.id, title.trim().slice(0, 200));
  }
  return { app: settings(), chat: Object.keys(patch).length ? await sessions.updateChat(req.params.id, patch) : chatSettings(req.params.id) };
});

app.get('/api/push/key', () => ({ publicKey: push.publicKey }));

app.post<{ Body: { endpoint: string } }>('/api/push/status', (req) => ({ subscribed: push.has(req.body?.endpoint) }));

app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>('/api/push/subscribe', async (req, reply) => {
  const sub = req.body;
  if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) {
    return reply.code(400).send({ error: 'invalid subscription' });
  }
  await push.subscribe(sub);
  return { ok: true };
});

app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', async (req) => {
  await push.unsubscribe(req.body?.endpoint);
  return { ok: true };
});

app.post('/api/push/test', async () => {
  await push.send({ title: 'pouch', body: 'Notifications are working.', url: '/', tag: 'test' });
  return { ok: true };
});

await app.listen({ host: HOST, port: PORT });
console.log(`pouch listening on http://${HOST}:${PORT}`);
