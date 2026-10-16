import { h, render } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'preact/hooks';
import htm from 'htm';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderSVG } from 'uqr';

const html = htm.bind(h);

// ---------- data layer ----------

// Set once the server answers 401: the app is swapped for the login screen until it reloads.
let locked = false;

const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login' && !locked) {
    locked = true;
    render(html`<${Login} />`, document.getElementById('app'));
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

const listeners = new Set();
let connected = false;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { connected = true; listeners.forEach((l) => l({ type: 'connected' })); };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); listeners.forEach((l) => l(m)); };
  ws.onclose = () => { connected = false; listeners.forEach((l) => l({ type: 'disconnected' })); if (!locked) setTimeout(connect, 1500); };
}
connect();

function useSocket(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (m) => ref.current(m);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
}

function useConnected() {
  const [on, setOn] = useState(connected);
  useSocket((m) => { if (m.type === 'connected') setOn(true); if (m.type === 'disconnected') setOn(false); });
  // The socket may have opened between render and subscribing.
  useEffect(() => setOn(connected), []);
  return on;
}

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setHash(location.hash || '#/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash;
}

const go = (hash) => { location.hash = hash; };
const base = (p) => (p || '').split('/').filter(Boolean).pop() || '~';
const STATUS = { needs_you: '🟡 needs you', working: '🟢 working', terminal: '🖥 terminal', done: '✅ done', idle: '⚪ idle' };
const STATUS_TEXT = { needs_you: 'needs you', working: 'working', terminal: 'in terminal', done: 'done', idle: 'idle' };
const statusText = (s) => s.status === 'terminal' && s.terminal?.busy ? 'busy in terminal' : STATUS_TEXT[s.status];
const statusLabel = (s) => s.status === 'terminal' && s.terminal?.busy ? '🖥 busy' : STATUS[s.status];

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}

// ---------- image attachments ----------

const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_DIM = 2000; // long edge; larger images get downscaled before upload
const MAX_KEEP = 1_500_000; // bytes; smaller images in a supported format are sent as-is
const MAX_ATTACH = 10;

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Turns a picked/pasted file into { mediaType, data, url }, downscaling big photos and screenshots. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  let blob = file;
  if (scale < 1 || !IMG_TYPES.includes(file.type) || file.size > MAX_KEEP) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no alpha
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  }
  bmp.close?.();
  const data = await blobToB64(blob);
  return { mediaType: blob.type, data, url: `data:${blob.type};base64,${data}` };
}

function useAttachments() {
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);
  const add = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return false;
    setBusy(true);
    try {
      const prepared = await Promise.all(list.map(prepareImage));
      setImages((cur) => [...cur, ...prepared].slice(0, MAX_ATTACH));
    } catch (e) { alert(`Couldn't read that image: ${e.message || e}`); }
    setBusy(false);
    return true;
  };
  return {
    images, busy, add,
    remove: (i) => setImages((cur) => cur.filter((_, j) => j !== i)),
    clear: () => setImages([]),
    onPaste: (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); add(files); }
    },
    payload: () => images.map(({ mediaType, data }) => ({ mediaType, data })),
  };
}

function AttachButton({ att, disabled }) {
  const ref = useRef(null);
  return html`<button class="attach" disabled=${disabled || att.busy || att.images.length >= MAX_ATTACH}
      onClick=${() => ref.current.click()} aria-label="Attach image">${att.busy ? '…' : '+'}</button>
    <input type="file" accept="image/*" multiple hidden ref=${ref}
      onChange=${(e) => { att.add(e.currentTarget.files); e.currentTarget.value = ''; }} />`;
}

function AttachPreview({ att }) {
  if (!att.images.length) return null;
  return html`<div class="thumbs">${att.images.map((img, i) => html`<div class="thumb" key=${i}>
    <img src=${img.url} alt="" />
    <button onClick=${() => att.remove(i)} aria-label="Remove image">×</button>
  </div>`)}</div>`;
}

function Lightbox({ src, onClose }) {
  if (!src) return null;
  return html`<div class="lightbox" onClick=${onClose}><img src=${src} alt="" /></div>`;
}

// ---------- push notifications ----------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
const swReady = pushSupported ? navigator.serviceWorker.register('/sw.js') : null;

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function usePush() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!pushSupported) return;
    swReady.then((reg) => reg.pushManager.getSubscription()).then(async (sub) => {
      if (sub) setOn((await api('/api/push/status', { endpoint: sub.endpoint })).subscribed);
    }).catch(() => {});
  }, []);

  const toggle = async () => {
    try {
      const reg = await swReady;
      const existing = await reg.pushManager.getSubscription();
      if (on && existing) {
        if (!confirm('Turn off notifications on this device?')) return;
        await api('/api/push/unsubscribe', { endpoint: existing.endpoint });
        await existing.unsubscribe();
        setOn(false);
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') {
        alert('Notifications are blocked. Allow them in the browser/site settings.');
        return;
      }
      const { publicKey } = await api('/api/push/key');
      const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await api('/api/push/subscribe', sub.toJSON());
      setOn(true);
      await api('/api/push/test', {});
    } catch (e) { alert(`Couldn't enable notifications: ${e.message}`); }
  };
  return { supported: pushSupported, on, toggle };
}

// ---------- shared pieces ----------

// Material-style line icons, drawn with currentColor so they follow the theme.
const ICONS = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  diff: 'M12 4v8M8 8h8M8 18h8M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
  stop: 'M7 7h10v10H7z',
  power: 'M12 3v9M6.34 6.34a8 8 0 1 0 11.32 0',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 21h4',
  bellOff: 'M6 16V11a6 6 0 0 1 9.2-5.07M18 11v5l2 2H4l2-2M10 21h4M3 3l18 18',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  close: 'M6 6l12 12M18 6L6 18',
};
const FILLED = new Set(['back', 'stop']);
function Icon({ name }) {
  const fill = FILLED.has(name);
  return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"
    fill=${fill ? 'currentColor' : 'none'} stroke=${fill ? 'none' : 'currentColor'}
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${ICONS[name]} /></svg>`;
}

function TopBar({ children, back }) {
  const on = useConnected();
  // Only flag the connection after a grace period, so page loads and quick blips don't flash a banner.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (on) { setOffline(false); return; }
    const t = setTimeout(() => setOffline(true), 1500);
    return () => clearTimeout(t);
  }, [on]);
  return html`<header class="topbar">
    <div class="topbar-row">
      ${back && html`<button class=${`icon-btn back${back === '#/' ? ' home' : ''}`} onClick=${() => go(back)} aria-label="Back"><${Icon} name="back" /></button>`}
      ${children}
    </div>
    ${offline && html`<div class="offline">Reconnecting…</div>`}
  </header>`;
}

function PendingCard({ sessionId, p }) {
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({});
  const respond = async (decision, extra) => {
    setBusy(true);
    try { await api(`/api/sessions/${sessionId}/respond`, { requestId: p.id, decision, ...extra }); }
    catch (e) { alert(e.message); setBusy(false); }
  };

  if (p.kind === 'question') {
    const toggle = (q, label) => {
      const cur = answers[q.question] ? answers[q.question].split(', ') : [];
      const next = q.multiSelect
        ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label])
        : [label];
      setAnswers({ ...answers, [q.question]: next.join(', ') });
    };
    const done = p.questions.every((q) => answers[q.question]);
    return html`<div class="pending">
      ${p.questions.map((q) => html`<div class="q">
        <div class="qtext">${q.question}</div>
        ${q.options.map((o) => html`<button
          class=${`btn opt ${(answers[q.question] || '').split(', ').includes(o.label) ? 'sel' : ''}`}
          onClick=${() => toggle(q, o.label)}>${o.label}<small>${o.description}</small></button>`)}
      </div>`)}
      <div class="row">
        <button class="btn danger" disabled=${busy} onClick=${() => respond('deny')}>Skip</button>
        <button class="btn primary" disabled=${busy || !done} onClick=${() => respond('allow', { answers })}>Answer</button>
      </div>
    </div>`;
  }

  return html`<div class="pending">
    <div class="ptitle">${p.title}</div>
    ${p.description && html`<div class="pdesc">${p.description}</div>`}
    ${p.summary && html`<div class="psum">${p.summary}</div>`}
    <div class="row">
      <button class="btn danger" disabled=${busy} onClick=${() => respond('deny')}>Deny</button>
      ${p.canAlways && html`<button class="btn" disabled=${busy} onClick=${() => respond('always')}>Always</button>`}
      <button class="btn primary" disabled=${busy} onClick=${() => respond('allow')}>Approve</button>
    </div>
  </div>`;
}

// ---------- dashboard ----------

const RANK = { needs_you: 0, working: 1, terminal: 2, done: 3, idle: 4 };
const bySessionRank = (a, b) => RANK[a.status] - RANK[b.status] || b.lastActivity - a.lastActivity;

// Apply a live session update to a loaded list. `keep` decides whether a session not yet listed belongs.
const mergeSession = (cur, session, keep = () => true) => {
  if (!cur) return cur;
  const rest = cur.filter((s) => s.id !== session.id);
  return rest.length === cur.length && !keep(session) ? cur : [session, ...rest].sort(bySessionRank);
};

function SessionCard(s, sel) {
  return html`<div class=${`card ${s.status}${s.id === sel ? ' sel' : ''}`} key=${s.id}>
    <div onClick=${() => go(`#/s/${s.id}`)}>
      <div class="card-head"><b>${s.title}</b><span class=${`pill ${s.status}`}>${statusLabel(s)}</span></div>
      <div class="meta">${base(s.cwd)} · ${ago(s.lastActivity)}${s.terminal?.tmux ? ` · tmux ${s.terminal.tmux.split('.')[0]}` : ''}${s.tasks?.length ? html` · <span class="bg-count">⚙ ${s.tasks.length} in background</span>` : ''}</div>
      ${s.lastText && !s.pending.length && html`<div class="last">${s.lastText}</div>`}
    </div>
    ${s.pending[0] && s.pending[0].kind === 'permission'
      ? html`<${PendingCard} sessionId=${s.id} p=${s.pending[0]} />`
      : s.pending[0] && html`<div class="last" onClick=${() => go(`#/s/${s.id}`)}>❓ Claude has a question, tap to answer</div>`}
  </div>`;
}

const gb = (n) => (n / 2 ** 30).toFixed(1);
// Amber past `warn`, red past `err`, as a fraction of the total.
const level = (used, total, warn, err) => (total && used / total > err ? 'err' : total && used / total > warn ? 'warn' : '');

function SystemStats({ s }) {
  const stats = [
    ['Load', s.load.toFixed(2), level(s.load, s.cpus, 1, 2)],
    ['RAM', `${gb(s.mem.used)}/${gb(s.mem.total)}G`, level(s.mem.used, s.mem.total, 0.85, 0.95)],
    s.swap.total > 0 && ['Swap', `${gb(s.swap.used)}G`, level(s.swap.used, s.swap.total, 0.5, 0.8)],
    ['Disk', `${Math.round((100 * s.disk.used) / s.disk.total)}%`, level(s.disk.used, s.disk.total, 0.85, 0.95)],
  ].filter(Boolean);
  return html`<div class="stats">${stats.map(([k, v, l]) => html`<span class=${l}>${k} <b>${v}</b></span>`)}</div>`;
}

const PROJECTS_SHOWN = 5;

function ProjectList({ projects }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const match = projects.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  // Active projects always show; the rest are capped until expanded.
  const shown = all ? match : match.filter((p, i) => i < PROJECTS_SHOWN || p.active > 0);
  const hidden = projects.length - shown.length;
  return html`
    <div class="section-label">Projects (${projects.length})</div>
    ${all && projects.length >= 10 && html`<input class="filter" type="search" placeholder="Filter projects"
      value=${q} onInput=${(e) => setQ(e.target.value)} />`}
    <div class="list">
      ${shown.map((p) => html`<button class="row" key=${p.path} onClick=${() => go(`#/p/${encodeURIComponent(p.name)}`)}>
        <span class="mono">${p.name[0].toUpperCase()}</span>
        <span class="row-main">
          <span class="row-title">${p.name}</span>
          <span class="row-meta">${[
            p.lastActivity ? `Active ${ago(p.lastActivity)}${ago(p.lastActivity) === 'now' ? '' : ' ago'}` : 'No sessions yet',
            p.worktrees > 0 && `${p.worktrees} worktree${p.worktrees > 1 ? 's' : ''}`,
            !p.git && 'not a git repo',
          ].filter(Boolean).join(' · ')}</span>
        </span>
        ${p.active > 0 && html`<span class="pill working">${p.active} running</span>`}
        <span class="chev" aria-hidden="true">›</span>
      </button>`)}
      ${all && !shown.length && html`<div class="row empty-row">No matches</div>`}
      ${(hidden > 0 || all) && projects.length > PROJECTS_SHOWN && html`<button class="row more" onClick=${() => { setAll(!all); setQ(''); }}>
        ${all ? 'Show less' : `Show all ${projects.length} projects`}</button>`}
      <button class="row more" onClick=${() => go('#/add')}>+ Add project</button>
    </div>`;
}

function useShells() {
  const [shells, setShells] = useState([]);
  const load = () => api('/api/shells').then(setShells).catch(() => {});
  useEffect(() => { load(); }, []);
  useSocket((m) => {
    if (m.type === 'connected') load();
    if (m.type === 'shells') setShells(m.shells);
  });
  return shells;
}

const openShell = async (cwd) => {
  try { const { id } = await api('/api/shells', { cwd }); go(`#/t/${id}`); }
  catch (e) { alert(e.message); }
};

function ShellCard(s, sel) {
  return html`<div class=${`card${s.id === sel ? ' sel' : ''}`} key=${s.id} onClick=${() => go(`#/t/${s.id}`)}>
    <div class="card-head"><b>${base(s.cwd)}</b><span class="pill idle">${base(s.process)}</span></div>
    <div class="meta">Terminal · opened ${ago(s.created)}${ago(s.created) === 'now' ? '' : ' ago'}</div>
  </div>`;
}

// `sel` is the session or shell open next to the sidebar on wide screens.
function Dashboard({ sel }) {
  const [list, setList] = useState(null);
  const [projects, setProjects] = useState([]);
  const [system, setSystem] = useState(null);
  const [showOld, setShowOld] = useState(false);
  const shells = useShells();
  const load = () => {
    api('/api/sessions').then(setList).catch(() => {});
    api('/api/projects').then(setProjects).catch(() => {});
    api('/api/system').then(setSystem).catch(() => {});
  };
  useEffect(() => {
    load();
    // Terminal sessions change state outside pouch, so poll for them while the dashboard is visible.
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => clearInterval(t);
  }, []);
  useSocket((m) => {
    if (m.type === 'connected') load();
    if (m.type === 'session') setList((cur) => mergeSession(cur, m.session));
  });

  const active = (list || []).filter((s) => s.live || s.terminal);
  const recent = (list || []).filter((s) => !s.live && !s.terminal);

  return html`<div class="screen">
    <${TopBar}>
      <h1>pouch</h1>
      <button class="icon-btn" onClick=${() => go('#/settings')} aria-label="Settings"><${Icon} name="settings" /></button>
    </${TopBar}>
    <div class="scroll">
      ${system && html`<${SystemStats} s=${system} />`}
      ${list === null && html`<div class="empty">Loading…</div>`}
      ${list && !active.length && !shells.length && html`<div class="empty">No running sessions.<br/>Start one below.</div>`}
      ${active.map((s) => SessionCard(s, sel))}
      ${shells.map((s) => ShellCard(s, sel))}
      <${ProjectList} projects=${projects} />
      ${recent.length > 0 && html`<div class="section-label" onClick=${() => setShowOld(!showOld)}>
        Recent sessions (${recent.length}) ${showOld ? '▾' : '▸'}</div>`}
      ${showOld && recent.map((s) => SessionCard(s, sel))}
    </div>
    <div class="fab-bar"><button class="btn primary wide" onClick=${() => go('#/new')}>+ New task</button></div>
  </div>`;
}

// ---------- session ----------


function Diff({ text }) {
  return html`<pre class="diff">${text.split('\n').map((l) => {
    const c = l.startsWith('@@') ? 'hunk'
      : l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') ? 'meta'
      : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return html`<span class=${c}>${l}\n</span>`;
  })}</pre>`;
}

const elapsed = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// Background agents, shells and workflows the session has running; they outlive the turn that started them.
function BackgroundTasks({ sessionId, tasks }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const stop = async (t) => {
    if (!confirm(`Stop "${t.description}"?`)) return;
    try { await api(`/api/sessions/${sessionId}/tasks/${encodeURIComponent(t.id)}/stop`, {}); } catch (e) { alert(e.message); }
  };
  return html`<details class="bg-tasks">
    <summary><span class="spin"></span>${tasks.length} running in background</summary>
    ${tasks.map((t) => html`<div class="bg-task" key=${t.id}>
      <div class="bg-main">
        <div><span class="bg-type">${t.type}</span> ${t.description}</div>
        <small>${elapsed(t.startedAt)}${t.toolUses ? ` · ${t.toolUses} tool uses` : ''}${t.summary ? ` · ${t.summary}` : t.lastTool ? ` · ${t.lastTool}` : ''}</small>
      </div>
      <button class="chip" onClick=${() => stop(t)}>Stop</button>
    </div>`)}
  </details>`;
}

const termLabel = (t) => `${t.busy ? 'busy' : 'idle'} in terminal${t.tmux ? ` (tmux ${t.tmux.split('.')[0]})` : ''}`;
// A mouse/trackpad suggests a physical keyboard: there Enter sends (Shift+Enter for a newline); on touch it stays a newline.
const desktopKeys = matchMedia('(hover: hover) and (pointer: fine)');

function Session({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState(null);
  const [viewing, setViewing] = useState(null);
  const att = useAttachments();
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const stick = useRef(true);

  const load = () => api(`/api/sessions/${id}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); setSelected(null); load(); }, [id]);
  useSocket((m) => {
    if (m.type === 'connected') load();
    if (m.type === 'session' && m.session.id === id) setData((d) => d && { ...d, session: { ...m.session, terminal: d.session.terminal } });
    if (m.type === 'event' && m.sessionId === id) {
      setData((d) => d && (d.events.some((e) => e.id === m.event.id) ? d : { ...d, events: [...d.events, m.event] }));
    }
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // Fit the composer to its text; keyed on text so it shrinks back after a send clears it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (text) el.style.height = el.scrollHeight + el.offsetHeight - el.clientHeight + 'px';
  }, [text, !!data]);

  const results = useMemo(() => {
    const r = {};
    for (const e of data?.events || []) if (e.kind === 'tool_result') r[e.toolUseId] = e;
    return r;
  }, [data?.events]);

  // force: send despite the session being open in a terminal
  const send = async (msg, force) => {
    const t = (msg ?? text).trim();
    const images = att.payload();
    if (!t && !images.length) return;
    setSending(true);
    stick.current = true;
    try {
      await api(`/api/sessions/${id}/message`, { text: t, force: !!force, images: images.length ? images : undefined });
      if (msg === undefined) setText('');
      att.clear();
    } catch (e) { alert(e.message); }
    setSending(false);
  };

  const end = async () => {
    const bg = data.session.tasks?.length ? ` Its ${data.session.tasks.length} background task(s) are stopped too.` : '';
    if (!confirm(`End this session? It stops its claude process; sending a message resumes it.${bg}`)) return;
    try { await api(`/api/sessions/${id}/end`, {}); } catch (e) { alert(e.message); }
  };

  if (error) return html`<div class="screen"><${TopBar} back="#/"><div class="title"><b>Error</b></div></${TopBar}><div class="empty">${error}</div></div>`;
  if (!data) return html`<div class="screen"><${TopBar} back="#/"><div class="title"><b>Loading…</b></div></${TopBar}></div>`;
  const s = data.session;
  const inTerminal = !!s.terminal;

  return html`<div class="screen">
    <${TopBar} back="#/">
      <div class="title"><b>${s.title}</b><small><span class=${`dot ${s.status}`}></span>${base(s.cwd)} · ${statusText(s)}</small></div>
      ${s.status === 'working' && html`<button class="icon-btn danger" aria-label="Stop" title="Stop" onClick=${() => api(`/api/sessions/${id}/interrupt`, {})}><${Icon} name="stop" /></button>`}
      ${s.live && s.status !== 'working' && html`<button class="icon-btn" aria-label="End session" title="End session" onClick=${end}><${Icon} name="power" /></button>`}
      <button class="icon-btn" aria-label="Changes" title="Changes" onClick=${() => go(`#/s/${id}/changes`)}><${Icon} name="diff" /></button>
      <button class="icon-btn" aria-label="Chat settings" title="Chat settings" onClick=${() => go(`#/s/${id}/settings`)}><${Icon} name="settings" /></button>
    </${TopBar}>
    ${inTerminal && html`<div class="banner">🖥 This session is ${termLabel(s.terminal)}. Sending here would mix two conversations.
      Finish it in the terminal, or send anyway.</div>`}
    <div class="scroll" ref=${scrollRef}
      onScroll=${(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      ${data.events.map((e) => {
        if (e.kind === 'user') return html`<div class="msg user" key=${e.id}><div class="bubble">
          ${e.images?.length > 0 && html`<div class="bubble-imgs">${e.images.map((src) => html`<img src=${src} alt="" onClick=${() => setViewing(src)} />`)}</div>`}
          ${e.text}
        </div></div>`;
        if (e.kind === 'assistant') {
          return html`<div key=${e.id}>
            <div class=${`msg assistant ${selected === e.id ? 'sel' : ''}`} onClick=${() => setSelected(selected === e.id ? null : e.id)}
              dangerouslySetInnerHTML=${{ __html: md(e.text) }}></div>
            ${selected === e.id && html`<div class="msg-actions">
              <button class="chip" onClick=${() => navigator.clipboard?.writeText(e.text)}>Copy</button>
            </div>`}
          </div>`;
        }
        if (e.kind === 'tool') {
          const r = results[e.id];
          const icon = !r ? '⏳' : r.isError ? '✗' : '✓';
          return html`<div key=${e.id}><details class=${`tool ${r?.isError ? 'error' : ''}`}>
            <summary><span>${icon}</span><span class="name">${e.name}</span><span class="sum">${s.cwd ? e.summary.replaceAll(s.cwd + '/', '') : e.summary}</span></summary>
            ${e.diff && html`<${Diff} text=${e.diff} />`}
            ${r && r.output && !(e.diff && !r.isError) && html`<pre>${r.output}</pre>`}
          </details>
          ${r?.images?.length > 0 && html`<div class="bubble-imgs tool-imgs">${r.images.map((src) => html`<img src=${src} alt="" onClick=${() => setViewing(src)} />`)}</div>`}</div>`;
        }
        if (e.kind === 'result') {
          const secs = e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : '';
          return html`<div class=${`result ${e.ok ? '' : 'fail'}`} key=${e.id}>${e.ok ? `— done${secs} —` : `— failed${secs} — ${e.text || ''}`}</div>`;
        }
        if (e.kind === 'error') return html`<div class="error-line" key=${e.id}>⚠ ${e.text}</div>`;
        return null;
      })}
    </div>
    ${s.tasks?.length > 0 && html`<${BackgroundTasks} sessionId=${id} tasks=${s.tasks} />`}
    ${s.pending.map((p) => html`<${PendingCard} key=${p.id} sessionId=${id} p=${p} />`)}
    <${Lightbox} src=${viewing} onClose=${() => setViewing(null)} />
    <div class="composer">
      <${AttachPreview} att=${att} />
      <div class="input-row">
        <${AttachButton} att=${att} disabled=${sending} />
        <textarea ref=${inputRef} rows="1" onPaste=${att.onPaste} placeholder=${inTerminal ? 'Message the terminal session…' : s.live ? 'Message Claude…' : 'Message to resume this session…'} value=${text}
          onInput=${(e) => setText(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing || inTerminal || !desktopKeys.matches) return;
            e.preventDefault();
            if (!sending && !att.busy) send();
          }}></textarea>
        ${!inTerminal && html`<button class="send" disabled=${sending || att.busy || (!text.trim() && !att.images.length)} onClick=${() => send()} aria-label="Send">↑</button>`}
      </div>
      ${inTerminal && html`<div class="row spaced">
        <button class="btn primary" disabled=${sending || att.busy || (!text.trim() && !att.images.length)}
          onClick=${() => confirm('Send into the session that is open in the terminal anyway? Both sides may get confused.') && send(undefined, true)}>Send anyway</button>
      </div>`}
    </div>
  </div>`;
}

// ---------- changes ----------

const FILE_STATUS = { modified: 'M', added: 'A', deleted: 'D', untracked: 'new', binary: 'bin' };

function useChanges(id) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api(`/api/sessions/${id}/changes`).then(setC).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  return { c, err, load };
}

function Changes({ id }) {
  const { c, err, load } = useChanges(id);
  return html`<div class="screen">
    <${TopBar} back=${`#/s/${id}`}>
      <div class="title"><b>Changes</b><small>${c ? `${base(c.cwd)}${c.git ? ` · ${c.branch}` : ''}` : ''}</small></div>
      <button class="icon-btn" aria-label="Refresh" onClick=${load}><${Icon} name="refresh" /></button>
    </${TopBar}>
    <div class="scroll">
      ${err && html`<div class="empty">${err}</div>`}
      ${!c && !err && html`<div class="empty">Loading…</div>`}
      ${c && !c.git && html`<div class="empty">Not a git repository.</div>`}
      ${c && c.git && !c.files.length && html`<div class="empty">No uncommitted changes.</div>`}
      ${c && c.git && c.files.map((f, i) => html`<button class="card file" key=${f.path} onClick=${() => go(`#/s/${id}/changes/${i}`)}>
        <span class=${`fstat ${f.status}`}>${FILE_STATUS[f.status]}</span>
        <span class="fpath">${f.path}</span>
        <span class="fnum">${f.status !== 'untracked' && f.status !== 'binary' ? html`<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>` : ''}</span>
      </button>`)}
    </div>
  </div>`;
}

function FileDiff({ id, index }) {
  const { c } = useChanges(id);
  const [diff, setDiff] = useState(null);
  const touch = useRef(null);
  const f = c?.git ? c.files[index] : null;
  const n = c?.git ? c.files.length : 0;
  useEffect(() => {
    setDiff(null);
    if (f) api(`/api/sessions/${id}/diff?path=${encodeURIComponent(f.path)}`).then((r) => setDiff(r.diff)).catch((e) => setDiff(`error: ${e.message}`));
  }, [f?.path]);
  const to = (i) => { if (i >= 0 && i < n) go(`#/s/${id}/changes/${i}`); };

  return html`<div class="screen"
    onTouchStart=${(e) => { touch.current = [e.touches[0].clientX, e.touches[0].clientY]; }}
    onTouchEnd=${(e) => {
      if (!touch.current) return;
      const dx = e.changedTouches[0].clientX - touch.current[0];
      const dy = e.changedTouches[0].clientY - touch.current[1];
      touch.current = null;
      if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy)) to(index + (dx < 0 ? 1 : -1));
    }}>
    <${TopBar} back=${`#/s/${id}/changes`}>
      <div class="title"><b>${f ? base(f.path) : 'Diff'}</b><small>${f ? `${index + 1} / ${n} · ${f.path}` : ''}</small></div>
    </${TopBar}>
    <div class="scroll">
      ${!c && html`<div class="empty">Loading…</div>`}
      ${c && !f && html`<div class="empty">File no longer changed.</div>`}
      ${f && diff === null && html`<div class="empty">Loading…</div>`}
      ${f && diff !== null && (diff ? html`<${Diff} text=${diff} />` : html`<div class="empty">No textual diff.</div>`)}
    </div>
    <div class="fab-bar row">
      <button class="btn" disabled=${index <= 0} onClick=${() => to(index - 1)}>← Prev</button>
      <button class="btn" disabled=${index >= n - 1} onClick=${() => to(index + 1)}>Next →</button>
    </div>
  </div>`;
}

// ---------- project ----------

function Project({ name }) {
  const [p, setP] = useState(null);
  const [prs, setPrs] = useState(null);
  const [showOld, setShowOld] = useState(false);
  const load = () => api(`/api/projects/${encodeURIComponent(name)}`).then(setP).catch((e) => alert(e.message));
  useEffect(() => {
    load();
    api(`/api/projects/${encodeURIComponent(name)}/prs`).then(setPrs).catch(() => setPrs([]));
  }, [name]);
  useSocket((m) => {
    if (m.type === 'connected' || (m.type === 'worktrees' && m.project === name)) load();
    if (m.type === 'session') setP((cur) => cur && {
      ...cur,
      sessions: mergeSession(cur.sessions, m.session,
        (s) => [cur.path, ...cur.worktrees.map((w) => w.path)].some((d) => s.cwd === d || s.cwd.startsWith(d + '/'))),
    });
  });

  const allShells = useShells();
  const shells = p ? allShells.filter((s) => [p.path, ...p.worktrees.map((w) => w.path)].some((d) => s.cwd === d || s.cwd.startsWith(d + '/'))) : [];
  const g = p?.git;
  const active = (p?.sessions || []).filter((s) => s.live || s.terminal);
  const recent = (p?.sessions || []).filter((s) => !s.live && !s.terminal);
  const review = { APPROVED: ' · approved', CHANGES_REQUESTED: ' · changes requested' };
  const [removing, setRemoving] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [branches, setBranches] = useState(null); // null: picker closed, 'loading', or the list
  const [switching, setSwitching] = useState(null);
  const [branchQuery, setBranchQuery] = useState('');
  const [allBranches, setAllBranches] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState(null);

  const toggleBranches = () => {
    if (branches) return setBranches(null);
    setBranchQuery('');
    setAllBranches(false);
    setBranches('loading');
    api(`/api/projects/${encodeURIComponent(name)}/branches`).then(setBranches).catch((e) => { setBranches(null); alert(e.message); });
  };

  const switchTo = async (b) => {
    const here = active.filter((s) => s.cwd === p.path || s.cwd.startsWith(p.path + '/')).length
      + shells.filter((s) => s.cwd === p.path || s.cwd.startsWith(p.path + '/')).length;
    if (here && !confirm(`${here} session${here > 1 ? 's or terminals are' : ' or terminal is'} open in ${name}. Switch to ${b.name} under them anyway?`)) return;
    setSwitching(b.name);
    try {
      await api(`/api/projects/${encodeURIComponent(name)}/switch`, { branch: b.name, remote: !!b.remote });
      setBranches(null);
    } catch (e) { alert(`Switch failed: ${e.message}`); }
    setSwitching(null);
    load();
  };

  const deletable = (b) => !b.remote && !b.current && !b.worktree && !b.default;
  const reloadBranches = () => api(`/api/projects/${encodeURIComponent(name)}/branches`).then(setBranches).catch(() => {});
  const branchUrl = `/api/projects/${encodeURIComponent(name)}/branches/delete`;

  const deleteBranch = async (b) => {
    setDeletingBranch(b.name);
    try {
      if (b.merged) {
        if (confirm(`Delete branch ${b.name}? It's merged.`)) await api(branchUrl, { branch: b.name });
      } else {
        try { await api(branchUrl, { branch: b.name }); }
        catch (e) {
          if (!/isn't merged/.test(e.message)) throw e;
          if (confirm(`${e.message}\n\nDelete ${b.name} anyway?`)) await api(branchUrl, { branch: b.name, force: true });
        }
      }
    } catch (e) { alert(`Delete failed: ${e.message}`); }
    setDeletingBranch(null);
    reloadBranches();
  };

  const deleteMerged = async (list) => {
    if (!confirm(`Delete ${list.length} merged branch${list.length > 1 ? 'es' : ''}?\n\n${list.map((b) => b.name).join('\n')}`)) return;
    setDeletingBranch('*');
    const failed = [];
    for (const b of list) await api(branchUrl, { branch: b.name }).catch((e) => failed.push(`${b.name}: ${e.message}`));
    if (failed.length) alert(`Some weren't deleted:\n\n${failed.join('\n')}`);
    setDeletingBranch(null);
    reloadBranches();
  };

  const doPull = async () => {
    setPulling(true);
    try {
      const { output } = await api(`/api/projects/${encodeURIComponent(name)}/pull`, {});
      alert(output || 'Pulled');
    } catch (e) { alert(`Pull failed: ${e.message}`); }
    setPulling(false);
    load();
  };

  const remove = async (w) => {
    if (!confirm(`Remove worktree ${w.name}? The branch ${w.branch || ''} is kept.`)) return;
    setRemoving(w.path);
    const url = `/api/projects/${encodeURIComponent(name)}/worktrees/remove`;
    try { await api(url, { path: w.path }); }
    catch (e) {
      if (!/uncommitted/.test(e.message) || !confirm(`${w.name} has uncommitted changes. Remove anyway and lose them?`)) {
        if (!/uncommitted/.test(e.message)) alert(e.message);
        setRemoving(null);
        return;
      }
      try { await api(url, { path: w.path, force: true }); } catch (e2) { alert(e2.message); }
    }
    setRemoving(null);
    load();
  };

  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    setDeleting(true);
    const url = `/api/projects/${encodeURIComponent(name)}/delete`;
    try {
      const { blockers, risks } = await api(url);
      if (blockers.length) throw new Error(`Can't delete ${name}:\n\n${blockers.join('\n')}`);
      const lose = risks.length ? `You will lose:\n${risks.map((r) => `• ${r}`).join('\n')}\n\n` : 'Everything is pushed and committed.\n\n';
      const typed = prompt(`Delete ${name} from disk? This can't be undone.\n\n${lose}Ignored files (like .env) aren't checked. Session history is kept.\n\nType ${name} to confirm:`);
      if (typed === null) return;
      if (typed.trim() !== name) throw new Error("The name didn't match, nothing was deleted.");
      await api(url, { confirm: name });
      go('#/');
    } catch (e) { alert(e.message); }
    finally { setDeleting(false); }
  };

  return html`<div class="screen">
    <${TopBar} back="#/"><h1>${name}</h1></${TopBar}>
    <div class="scroll">
      ${!p && html`<div class="empty">Loading…</div>`}
      ${p && html`<div class="repo">
        ${g ? html`<button class=${`btn small branch-btn ${branches ? 'sel' : ''}`} onClick=${toggleBranches}>${g.branch} ${branches ? '▴' : '▾'}</button>
          <span>${g.changed ? `${g.changed} uncommitted` : 'clean'}</span>
          ${g.ahead > 0 && html`<span>↑${g.ahead}</span>`}
          ${g.behind > 0 && html`<span>↓${g.behind}</span>`}
          ${g.ahead !== undefined && html`<button class="btn small repo-pull" disabled=${pulling} onClick=${doPull}>${pulling ? 'Pulling…' : 'Pull'}</button>`}` : html`<span>Not a git repo</span>`}
      </div>`}
      ${branches === 'loading' && html`<div class="empty small">Fetching branches…</div>`}
      ${Array.isArray(branches) && (() => {
        const q = branchQuery.trim().toLowerCase();
        const shown = q ? branches.filter((b) => b.name.toLowerCase().includes(q))
          : allBranches ? branches : branches.slice(0, branches[0]?.current ? 6 : 5);
        const merged = branches.filter((b) => b.merged && deletable(b));
        const busy = switching || deletingBranch;
        return html`<div class="branches">
          ${branches.length > 6 && html`<input class="filter" type="search" placeholder=${`Search ${branches.length} branches`} value=${branchQuery}
            autocapitalize="off" autocorrect="off" spellcheck="false" onInput=${(e) => setBranchQuery(e.target.value)} />`}
          ${merged.length > 0 && !q && html`<button class="btn small branch-clean" disabled=${busy} onClick=${() => deleteMerged(merged)}>
            ${deletingBranch === '*' ? 'Deleting…' : `Delete ${merged.length} merged`}</button>`}
          ${shown.map((b) => html`<div class=${`card branch ${b.current ? 'sel' : ''}`} key=${(b.remote ? 'r:' : '') + b.name}>
            <button class="branch-main" disabled=${b.current || b.worktree || busy} onClick=${() => switchTo(b)}>
              <b>${b.name}</b>
              <span class="meta">${[switching === b.name ? 'Switching…' : b.current ? 'current' : b.worktree ? `in ${b.worktree.split('/').pop()}` : b.remote ? 'on origin only' : '', b.merged && 'merged', b.date && ago(b.date * 1000)].filter(Boolean).join(' · ')}</span>
            </button>
            ${deletable(b) && html`<button class="btn small branch-del" aria-label=${`Delete ${b.name}`} disabled=${busy} onClick=${() => deleteBranch(b)}>
              ${deletingBranch === b.name ? '…' : 'Delete'}</button>`}
          </div>`)}
          ${q && !shown.length && html`<div class="empty small">No branch matches.</div>`}
          ${!q && !allBranches && branches.length > shown.length && html`<button class="btn small branch-more" onClick=${() => setAllBranches(true)}>
            Show all ${branches.length}</button>`}
        </div>`;
      })()}
      ${prs?.length > 0 && html`<div class="section-label">Open PRs (${prs.length})</div>
        ${prs.map((pr) => html`<a class="card pr" href=${pr.url} target="_blank" rel="noopener" key=${pr.number}>
          <div class="card-head"><b>${pr.title}</b><span class="meta">#${pr.number}</span></div>
          <div class="meta">${pr.headRefName}${pr.isDraft ? ' · draft' : ''}${review[pr.reviewDecision] || ''}</div>
        </a>`)}`}
      ${p?.worktrees.length > 0 && html`<div class="section-label">Worktrees (${p.worktrees.length})</div>
        ${p.worktrees.map((w) => {
          const pr = prs?.find((x) => x.headRefName === w.branch);
          return html`<div class="card" key=${w.path}>
            <div class="card-head"><b>${w.name}</b>
              <button class="btn small" onClick=${() => openShell(w.path)}>Terminal</button>
              <button class="btn small" disabled=${removing === w.path} onClick=${() => remove(w)}>Remove</button></div>
            <div class="meta">${w.branch || 'detached'} · ${w.git?.changed ? `${w.git.changed} uncommitted` : 'clean'}${w.git?.ahead > 0 ? ` · ↑${w.git.ahead}` : ''}</div>
            ${pr && html`<a class="meta pr-link" href=${pr.url} target="_blank" rel="noopener">PR #${pr.number}${pr.isDraft ? ' · draft' : ''}${review[pr.reviewDecision] || ''} ↗</a>`}
          </div>`;
        })}`}
      ${p && html`<div class="section-label">Sessions</div>`}
      ${p && !active.length && html`<div class="empty small">Nothing running here.</div>`}
      ${active.map((s) => SessionCard(s))}
      ${shells.length > 0 && html`<div class="section-label">Terminals (${shells.length})</div>`}
      ${shells.map((s) => ShellCard(s))}
      ${recent.length > 0 && html`<div class="section-label" onClick=${() => setShowOld(!showOld)}>
        Recent sessions (${recent.length}) ${showOld ? '▾' : '▸'}</div>`}
      ${showOld && recent.map((s) => SessionCard(s))}
      ${p && html`<button class="btn small danger delete-project" disabled=${deleting} onClick=${del}>${deleting ? 'Checking…' : 'Delete project'}</button>`}
    </div>
    <div class="fab-bar split">
      <button class="btn" disabled=${!p} onClick=${() => openShell(p.path)}>Terminal</button>
      <button class="btn primary" onClick=${() => go(`#/new/${encodeURIComponent(name)}`)}>+ New task here</button>
    </div>
  </div>`;
}

// ---------- terminal ----------

// Keys a phone keyboard lacks. Ctrl applies to the next key typed.
const KEYS = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', null], ['^C', '\x03'], ['↑', 'A'], ['↓', 'B'], ['←', 'D'], ['→', 'C']];

function Shell({ id }) {
  const box = useRef(null);
  const term = useRef(null);
  const ctrl = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [state, setState] = useState('connecting'); // open | exited | gone
  const sendRef = useRef(() => {});
  const shell = useShells().find((s) => s.id === id);

  useEffect(() => {
    let t, ws, ro, retry, done = false, replaying = false;
    const send = (m) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    sendRef.current = send;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (done) return;
      const css = getComputedStyle(document.documentElement);
      const v = (name) => css.getPropertyValue(name).trim();
      t = new Terminal({
        fontSize: 13, fontFamily: 'SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace', scrollback: 5000, cursorBlink: true,
        theme: { background: v('--surface'), foreground: v('--text'), cursor: v('--accent'), selectionBackground: v('--border') },
      });
      term.current = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(box.current);
      fit.fit();
      t.onData((d) => {
        // Replayed output can hold queries (cursor position, device attributes) xterm answers on its own;
        // the shell already got its answers, so these would land on the prompt as junk.
        if (replaying) return;
        if (ctrl.current && d.length === 1) {
          d = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31);
          ctrl.current = false;
          setCtrlOn(false);
        }
        send({ i: d });
      });
      t.onResize(({ cols, rows }) => send({ cols, rows }));
      ro = new ResizeObserver(() => fit.fit());
      ro.observe(box.current);
      const open = () => {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/shells/${id}/ws`);
        // The server replays recent output on every attach, so start from a clean screen.
        ws.onopen = () => { t.reset(); setState('open'); send({ cols: t.cols, rows: t.rows }); };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.replay) { replaying = true; t.write(m.replay, () => { replaying = false; }); }
          if (m.o) t.write(m.o);
          if (m.exit !== undefined) { done = true; setState('exited'); t.write(`\r\n[exited with code ${m.exit}]\r\n`); }
          if (m.gone) { done = true; setState('gone'); }
        };
        ws.onclose = () => { if (!done) { setState('connecting'); retry = setTimeout(open, 1500); } };
      };
      open();
      t.focus();
    })();
    return () => { done = true; clearTimeout(retry); ws?.close(); ro?.disconnect(); t?.dispose(); };
  }, [id]);

  const key = (k, seq) => {
    if (k === 'Ctrl') { ctrl.current = !ctrl.current; setCtrlOn(ctrl.current); }
    else if (seq.length === 1) sendRef.current({ i: seq });
    // Arrows: apps like less and vim switch the terminal to application cursor mode.
    else sendRef.current({ i: (term.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + seq });
    if (seq) term.current?.focus();
  };
  const kill = async () => {
    if (!confirm('Close this terminal? Anything running in it is stopped.')) return;
    try { await api(`/api/shells/${id}/kill`, {}); go('#/'); } catch (e) { alert(e.message); }
  };

  return html`<div class="screen">
    <${TopBar} back="#/">
      <div class="title"><b>${shell ? base(shell.cwd) : 'Terminal'}</b>
        <small>${state === 'open' ? (shell ? base(shell.process) : '') : state === 'connecting' ? 'Connecting…' : state === 'exited' ? 'Exited' : 'Closed'}</small></div>
      ${state === 'open' && html`<button class="icon-btn danger" aria-label="Close terminal" title="Close terminal" onClick=${kill}><${Icon} name="close" /></button>`}
    </${TopBar}>
    ${state === 'gone' && html`<div class="empty">This terminal is closed. Terminals end when pouch restarts.</div>`}
    <div class="term" ref=${box}></div>
    <div class="term-keys">
      ${KEYS.map(([k, seq]) => html`<button class=${`chip${k === 'Ctrl' && ctrlOn ? ' sel' : ''}`} key=${k}
        onPointerDown=${(e) => e.preventDefault()} onClick=${() => key(k, seq)}>${k}</button>`)}
    </div>
  </div>`;
}

// ---------- new task ----------

function NewTask({ project }) {
  const [projects, setProjects] = useState([]);
  const [cwd, setCwd] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [worktree, setWorktree] = useState(true);
  const att = useAttachments();
  const sel = projects.find((p) => p.path === cwd);
  useEffect(() => {
    api('/api/projects').then((list) => {
      setProjects(list);
      // Preselect the project we came from, else the most recently used one.
      const pick = list.find((p) => p.name === project) || (list[0]?.lastActivity ? list[0] : null);
      if (pick) setCwd((cur) => cur ?? pick.path);
    }).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    const images = att.payload();
    try { const { id } = await api('/api/sessions', { cwd, prompt, images: images.length ? images : undefined, worktree: sel?.git && worktree }); go(`#/s/${id}`); }
    catch (e) { alert(e.message); setBusy(false); }
  };

  return html`<div class="screen">
    <${TopBar} back=${project ? `#/p/${encodeURIComponent(project)}` : '#/'}><h1>New task</h1></${TopBar}>
    <div class="scroll">
      <div class="section-label">Project</div>
      <div class="projects">
        ${projects.map((p) => html`<button class=${`btn ${cwd === p.path ? 'sel' : ''}`} onClick=${() => setCwd(p.path)}>${p.name}</button>`)}
      </div>
      <div class="section-label">What should Claude do?</div>
      <textarea class="new-prompt" onPaste=${att.onPaste} placeholder="Describe the task, or use the keyboard mic to dictate…" value=${prompt}
        onInput=${(e) => setPrompt(e.currentTarget.value)}></textarea>
      <div class="new-attach"><${AttachButton} att=${att} disabled=${busy} /><span>Attach screenshots</span></div>
      <${AttachPreview} att=${att} />
      ${sel?.git && html`<button class=${`btn wide toggle new-wt ${worktree ? 'sel' : ''}`} onClick=${() => setWorktree(!worktree)}>
        ${worktree ? '✓ ' : ''}Isolated worktree</button>
        <div class="hint">${worktree
          ? `Works on a new branch in ${sel.name}-<branch>, off the latest main. Remove it from the project page when done.`
          : `Works directly in ${sel.name}, on whatever is checked out.`}</div>`}
    </div>
    <div class="fab-bar">
      <button class="btn primary wide" disabled=${busy || att.busy || !cwd || (!prompt.trim() && !att.images.length)} onClick=${start}>${busy && sel?.git && worktree ? 'Creating worktree…' : 'Start'}</button>
    </div>
  </div>`;
}

// ---------- add project ----------

const repoName = (url) => url.trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');

function AddProject() {
  const [mode, setMode] = useState('clone');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const finalName = name.trim() || (mode === 'clone' ? repoName(url) : '');

  const create = async () => {
    setBusy(true);
    try {
      const body = mode === 'clone' ? { url, name: name.trim() || undefined } : { name, git };
      const r = await api('/api/projects', body);
      go(`#/p/${encodeURIComponent(r.name)}`);
    } catch (e) { alert(e.message); setBusy(false); }
  };

  return html`<div class="screen">
    <${TopBar} back="#/"><h1>Add project</h1></${TopBar}>
    <div class="scroll">
      <div class="section-label">Source</div>
      <${Choices} options=${[['clone', 'Clone a repo'], ['new', 'New folder']]} value=${mode} onPick=${setMode} />
      ${mode === 'clone' && html`<div class="section-label">Repository</div>
        <input class="filter" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
          placeholder="owner/repo or https://… or git@…" value=${url} onInput=${(e) => setUrl(e.target.value)} />
        <div class="hint">owner/repo clones from GitHub with the box's gh login.</div>`}
      <div class="section-label">Folder name</div>
      <input class="filter" type="text" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder=${mode === 'clone' ? repoName(url) || 'From the repo name' : 'my-project'} value=${name} onInput=${(e) => setName(e.target.value)} />
      ${finalName && html`<div class="hint">Goes to Projects/${finalName}</div>`}
      ${mode === 'new' && html`<button class=${`btn wide toggle new-wt ${git ? 'sel' : ''}`} onClick=${() => setGit(!git)}>
        ${git ? '✓ ' : ''}Initialize git repo</button>`}
    </div>
    <div class="fab-bar">
      <button class="btn primary wide" disabled=${busy || !finalName || (mode === 'clone' && !url.trim())} onClick=${create}>
        ${busy ? (mode === 'clone' ? 'Cloning…' : 'Creating…') : (mode === 'clone' ? 'Clone' : 'Create')}</button>
    </div>
  </div>`;
}

// ---------- settings ----------

const MODELS = [['', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'X-High'], ['max', 'Max']];
const MODES = [
  ['auto', 'Auto', 'A classifier approves safe tool calls; you only see the ones it can\'t decide.'],
  ['acceptEdits', 'Accept edits', 'File edits go through; commands and other tools ask you.'],
  ['default', 'Ask', 'Every tool call that changes something asks you first.'],
];
const IDLE = [[10, '10 min'], [20, '20 min'], [60, '1 hour'], [0, 'Never']];
const MAX_LIVE = [[2, '2'], [4, '4'], [6, '6'], [0, 'No limit']];
const NOTIFY = [['needsYou', 'Needs you'], ['done', 'Done'], ['failed', 'Failed']];

function Choices({ options, value, onPick }) {
  return html`<div class="choices">
    ${options.map(([v, label]) => html`<button class=${`btn ${value === v ? 'sel' : ''}`} onClick=${() => onPick(v)}>${label}</button>`)}
  </div>`;
}

function McpServers({ off, onChange }) {
  const [list, setList] = useState(null);
  const load = (refresh) => {
    setList(null);
    api(`/api/mcp${refresh ? '?refresh=1' : ''}`).then(setList).catch((e) => { setList([]); alert(e.message); });
  };
  useEffect(() => load(false), []);
  // Servers turned off but no longer configured still show, so they can be turned back on.
  const names = list && [...new Set([...list.map((m) => m.name), ...off])];
  const toggle = (n) => onChange(off.includes(n) ? off.filter((x) => x !== n) : [...off, n]);
  return html`
    <div class="section-label">MCP servers</div>
    ${!names ? html`<div class="hint">Loading…</div>` : !names.length ? html`<div class="hint">No MCP servers configured.</div>` : html`
      <div class="choices">
        ${names.map((n) => html`<button class=${`btn ${off.includes(n) ? '' : 'sel'}`} onClick=${() => toggle(n)}>
          ${off.includes(n) ? '' : '✓ '}${n}</button>`)}
      </div>`}
    <div class="hint">Each loaded server adds its tools and instructions to every request. Turn off the ones pouch sessions don't need. Terminal sessions aren't affected, and servers in a project's .mcp.json aren't listed. <a href="#" onClick=${(e) => { e.preventDefault(); load(true); }}>Refresh</a></div>`;
}

function Settings() {
  const [s, setS] = useState(null);
  const push = usePush();
  useEffect(() => { api('/api/settings').then(setS).catch((e) => alert(e.message)); }, []);
  const save = async (patch) => {
    const prev = s;
    setS({ ...s, ...patch, notify: { ...s.notify, ...patch.notify } });
    try { setS(await api('/api/settings', patch)); }
    catch (e) { setS(prev); alert(e.message); }
  };
  const mode = s && MODES.find(([v]) => v === s.permissionMode);

  return html`<div class="screen">
    <${TopBar} back="#/"><h1>Settings</h1></${TopBar}>
    <div class="scroll">
      ${!s ? html`<div class="empty">Loading…</div>` : html`
        <div class="hint">New sessions, and sessions resumed after closing, use these. Running ones keep what they started with. Each chat can override these from its own settings.</div>
        <div class="section-label">Model</div>
        <${Choices} options=${MODELS} value=${s.model} onPick=${(model) => save({ model })} />
        <div class="section-label">Effort</div>
        <${Choices} options=${EFFORTS} value=${s.effort} onPick=${(effort) => save({ effort })} />
        <div class="section-label">Permissions</div>
        <${Choices} options=${MODES} value=${s.permissionMode} onPick=${(permissionMode) => save({ permissionMode })} />
        ${mode && html`<div class="hint">${mode[2]}</div>`}
        <div class="section-label">Close idle sessions after</div>
        <${Choices} options=${IDLE} value=${s.idleCloseMin} onPick=${(idleCloseMin) => save({ idleCloseMin })} />
        <div class="section-label">Sessions running at once</div>
        <${Choices} options=${MAX_LIVE} value=${s.maxLive} onPick=${(maxLive) => save({ maxLive })} />
        <div class="hint">Each running session uses about 250 MB of memory. Starting one past the limit closes the longest-idle session; ones that are working or waiting on you are never closed. Closed sessions resume when you message them.</div>
        <${McpServers} off=${s.mcpOff} onChange=${(mcpOff) => save({ mcpOff })} />
        <div class="section-label">Notifications</div>
        ${push.supported
          ? html`<button class=${`btn wide toggle ${push.on ? 'sel' : ''}`} onClick=${push.toggle}>
              <${Icon} name=${push.on ? 'bell' : 'bellOff'} /> ${push.on ? 'On for this device' : 'Turn on for this device'}</button>`
          : html`<div class="hint">This browser doesn't support push. On iPhone, add pouch to the home screen first.</div>`}
        <div class="hint">Notify me when a session…</div>
        <div class="choices">
          ${NOTIFY.map(([k, label]) => html`<button class=${`btn ${s.notify[k] ? 'sel' : ''}`}
            onClick=${() => save({ notify: { [k]: !s.notify[k] } })}>${s.notify[k] ? '✓ ' : ''}${label}</button>`)}
        </div>
        ${push.on && html`<button class="btn wide test" onClick=${() => api('/api/push/test', {}).catch((e) => alert(e.message))}>Send a test notification</button>`}
        <div class="section-label">Devices</div>
        <button class="btn wide" onClick=${() => go('#/scan')}>Scan a login QR code</button>
        <div class="hint">Log in another device by scanning the QR code on its login screen.</div>
      `}
    </div>
  </div>`;
}

// ---------- chat settings ----------

// Prepends a "same as app" choice ('') whose label shows what the app setting currently is.
const inherit = (options, appValue) => [['', `App (${options.find(([v]) => v === appValue)?.[1] ?? 'Default'})`], ...options.filter(([v]) => v)];

function ChatSettings({ id }) {
  const [d, setD] = useState(null);
  const [title, setTitle] = useState(null);
  useEffect(() => {
    api(`/api/sessions/${id}/settings`).then(setD).catch((e) => alert(e.message));
    api(`/api/sessions/${id}`).then((r) => setTitle(r.session.title)).catch(() => {});
  }, [id]);
  const save = async (patch) => {
    const prev = d;
    setD({ ...d, chat: { ...d.chat, ...patch } });
    try { setD(await api(`/api/sessions/${id}/settings`, patch)); }
    catch (e) { setD(prev); alert(e.message); }
  };
  const rename = async () => {
    try { await api(`/api/sessions/${id}/settings`, { title }); go(`#/s/${id}`); }
    catch (e) { alert(e.message); }
  };
  const c = d?.chat ?? {};
  const mode = d && MODES.find(([v]) => v === (c.permissionMode || d.app.permissionMode));

  return html`<div class="screen">
    <${TopBar} back=${`#/s/${id}`}><h1>Chat settings</h1></${TopBar}>
    <div class="scroll">
      ${!d ? html`<div class="empty">Loading…</div>` : html`
        <div class="section-label">Name</div>
        <div class="input-row">
          <textarea rows="1" value=${title ?? ''} placeholder="Session name" onInput=${(e) => setTitle(e.currentTarget.value)}></textarea>
          <button class="btn" disabled=${!title?.trim()} onClick=${rename}>Rename</button>
        </div>
        <div class="hint">Changes below apply right away, even mid-session. "App" follows the app-wide settings.</div>
        <div class="section-label">Model</div>
        <${Choices} options=${inherit(MODELS, d.app.model)} value=${c.model ?? ''} onPick=${(model) => save({ model })} />
        <div class="section-label">Effort</div>
        <${Choices} options=${inherit(EFFORTS, d.app.effort)} value=${c.effort ?? ''} onPick=${(effort) => save({ effort })} />
        <div class="section-label">Permissions</div>
        <${Choices} options=${inherit(MODES, d.app.permissionMode)} value=${c.permissionMode ?? ''} onPick=${(permissionMode) => save({ permissionMode })} />
        ${mode && html`<div class="hint">${mode[2]}</div>`}
      `}
    </div>
  </div>`;
}

// The new device's half of QR login: show a code, wait for a logged-in device to approve it.
function PairQR() {
  const [pair, setPair] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let stop = false;
    let timer;
    const start = async () => {
      try {
        const p = await api('/api/pair', {});
        if (stop) return;
        const url = `${location.origin}/#/pair/${p.code}`;
        setPair({ ...p, src: `data:image/svg+xml,${encodeURIComponent(renderSVG(url, { border: 2 }))}` });
        setErr(null);
        poll(p);
      } catch (e) {
        if (!stop) { setErr(e.message); timer = setTimeout(start, 10000); }
      }
    };
    const poll = async (p) => {
      try {
        const r = await api('/api/pair/claim', { code: p.code, claim: p.claim });
        if (r.ok) return location.reload();
      } catch {
        // Expired: show a fresh code.
        if (!stop) return start();
      }
      if (!stop) timer = setTimeout(() => poll(p), 2000);
    };
    start();
    return () => { stop = true; clearTimeout(timer); };
  }, []);
  return html`<div class="pair-qr">
    ${pair ? html`<img src=${pair.src} alt="QR code to log in" />` : html`<div class="pair-placeholder">${err || 'Loading…'}</div>`}
    <p>Scan with a phone that's logged in to pouch, then approve.</p>
  </div>`;
}

function Login() {
  const [token, setToken] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/login', { token: token.trim() });
      location.reload();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return html`<div class="screen">
    <form class="login" onSubmit=${submit}>
      <b>pouch</b>
      ${location.hash.startsWith('#/pair/')
        ? html`<p class="error-line">This browser isn't logged in, so it can't approve. Open the pouch app and scan the code from Settings → Scan a login QR code.</p>`
        : html`<${PairQR} />`}
      <p>Or paste the login token from <code>~/.config/pouch/token</code> on the server.</p>
      <input type="password" autocomplete="current-password" placeholder="Token" value=${token} onInput=${(e) => setToken(e.target.value)} />
      ${err && html`<div class="error-line">${err}</div>`}
      <button class="btn primary wide" disabled=${busy || !token.trim()}>Log in</button>
    </form>
  </div>`;
}

// The logged-in device's half: opened by scanning the QR code.
function PairApprove({ code }) {
  const [info, setInfo] = useState(null);
  const [state, setState] = useState(null);
  useEffect(() => {
    api(`/api/pair/${encodeURIComponent(code)}`).then(setInfo, (e) => setState({ err: e.message }));
  }, [code]);
  const approve = async () => {
    setState({ busy: true });
    try {
      await api(`/api/pair/${encodeURIComponent(code)}/approve`, {});
      setState({ done: true });
    } catch (e) {
      setState({ err: e.message });
    }
  };
  return html`<div class="screen">
    <div class="login">
      <b>Log in a new device?</b>
      ${state?.done ? html`<p>Done. The other device is logging in.</p>`
        : state?.err ? html`<div class="error-line">${state.err}</div>`
        : !info ? html`<p>Loading…</p>`
        : html`
          <p>It gets full access to pouch. Only approve a QR code shown on your own screen.</p>
          ${info.agent && html`<p class="hint">${info.agent}</p>`}
          <button class="btn primary wide" disabled=${state?.busy} onClick=${approve}>Approve</button>`}
      <button class="btn wide" onClick=${() => go('#/')}>${state?.done ? 'Back to pouch' : 'Cancel'}</button>
    </div>
  </div>`;
}

// Scans a login QR code with the camera, so a home-screen app can approve without the system camera
// (which opens the browser, logged out). BarcodeDetector where there is one, jsQR otherwise (iOS).
function ScanQR() {
  const video = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let stop = false;
    let stream;
    let timer;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current;
        v.srcObject = stream;
        await v.play();
        let detect;
        if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          const d = new BarcodeDetector({ formats: ['qr_code'] });
          detect = async () => (await d.detect(v))[0]?.rawValue;
        } else {
          const { default: jsQR } = await import('jsqr-es6');
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          detect = async () => {
            // Downscale: faster, and jsQR copes fine at this size.
            const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.round(v.videoWidth * k);
            canvas.height = Math.round(v.videoHeight * k);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
          };
        }
        const tick = async () => {
          if (stop) return;
          const text = v.videoWidth ? await detect().catch(() => null) : null;
          const m = text?.match(/#\/pair\/([\w-]+)$/);
          if (m && !stop) {
            if (!text.startsWith(location.origin + '/')) return setErr('That QR code is for a different pouch server.');
            return go(`#/pair/${m[1]}`);
          }
          timer = setTimeout(tick, 200);
        };
        tick();
      } catch (e) {
        if (!stop) setErr(e.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in the browser settings and try again.' : e.message);
      }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return html`<div class="screen">
    <${TopBar} back="#/settings"><h1>Scan login QR</h1></${TopBar}>
    <div class="scroll">
      ${err ? html`<div class="error-line">${err}</div>` : html`<video class="scan-video" ref=${video} playsinline muted />`}
      <div class="hint">Point the camera at the QR code on the other device's login screen.</div>
    </div>
  </div>`;
}

// ---------- toasts ----------

const TOAST_MS = 6000;

// Server notifications (done, failed, needs you) for sessions other than the one on screen.
function Toasts() {
  const [toasts, setToasts] = useState([]);
  const dismiss = (tag) => setToasts((cur) => cur.filter((t) => t.tag !== tag));
  useSocket((m) => {
    if (m.type !== 'notify') return;
    const n = m.notification;
    if (location.hash.startsWith(n.url.replace(/^\//, ''))) return;
    const t = { ...n, key: Math.random() };
    setToasts((cur) => [t, ...cur.filter((x) => x.tag !== n.tag)].slice(0, 3));
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.key !== t.key)), TOAST_MS);
  });
  if (!toasts.length) return null;
  return html`<div class="toasts">
    ${toasts.map((t) => html`<div class="toast" key=${t.key} role="status" onClick=${() => { dismiss(t.tag); go(t.url.replace(/^\//, '')); }}>
      <div class="toast-text"><b>${t.title}</b><span>${t.body}</span></div>
      <button class="icon-btn" aria-label="Dismiss" onClick=${(e) => { e.stopPropagation(); dismiss(t.tag); }}>×</button>
    </div>`)}
  </div>`;
}

// ---------- router ----------

// Wide screens keep the dashboard as a sidebar next to whatever screen is open.
const wideQuery = matchMedia('(min-width: 1000px)');
function useWide() {
  const [wide, setWide] = useState(wideQuery.matches);
  useEffect(() => {
    const f = () => setWide(wideQuery.matches);
    wideQuery.addEventListener('change', f);
    return () => wideQuery.removeEventListener('change', f);
  }, []);
  return wide;
}

function App() {
  const hash = useHash();
  const wide = useWide();
  if (!wide) return html`<${Route} hash=${hash} />`;
  const sel = hash.match(/^#\/[st]\/([\w-]+)/)?.[1];
  return html`<div class="split">
    <aside class="sidebar"><${Dashboard} sel=${sel} /></aside>
    <main class="pane"><${Route} hash=${hash} wide /></main>
  </div>`;
}

function Placeholder() {
  return html`<div class="screen placeholder">
    <div class="empty">Pick a session on the left, or start a new one.</div>
    <button class="btn primary" onClick=${() => go('#/new')}>+ New task</button>
  </div>`;
}

function Route({ hash, wide }) {
  const d = hash.match(/^#\/s\/([\w-]+)\/changes\/(\d+)$/);
  if (d) return html`<${FileDiff} id=${d[1]} index=${Number(d[2])} />`;
  const cs = hash.match(/^#\/s\/([\w-]+)\/settings$/);
  if (cs) return html`<${ChatSettings} id=${cs[1]} />`;
  const c = hash.match(/^#\/s\/([\w-]+)\/changes$/);
  if (c) return html`<${Changes} id=${c[1]} />`;
  const m = hash.match(/^#\/s\/([\w-]+)/);
  if (m) return html`<${Session} id=${m[1]} />`;
  const t = hash.match(/^#\/t\/([\w-]+)$/);
  if (t) return html`<${Shell} id=${t[1]} key=${t[1]} />`;
  const p = hash.match(/^#\/p\/([^/]+)$/);
  if (p) return html`<${Project} name=${decodeURIComponent(p[1])} />`;
  const n = hash.match(/^#\/new(?:\/([^/]+))?$/);
  if (n) return html`<${NewTask} project=${n[1] && decodeURIComponent(n[1])} />`;
  const pr = hash.match(/^#\/pair\/([\w-]+)$/);
  if (pr) return html`<${PairApprove} code=${pr[1]} />`;
  if (hash === '#/scan') return html`<${ScanQR} />`;
  if (hash === '#/settings') return html`<${Settings} />`;
  if (hash === '#/add') return html`<${AddProject} />`;
  return wide ? html`<${Placeholder} />` : html`<${Dashboard} />`;
}

render(html`<${App} /><${Toasts} />`, document.getElementById('app'));
