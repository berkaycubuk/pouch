import { randomUUID } from 'node:crypto';
import {
  query,
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './queue.js';
import { terminalSessions, type TerminalInfo } from './terminal.js';
import { fromApiMessage, toolSummary, type ImageInput, type UIEvent } from './events.js';
import type { PushPayload } from './push.js';
import { settings, effectiveSettings, updateChatSettings, claudeEnv } from './settings.js';

export type Status = 'needs_you' | 'working' | 'terminal' | 'done' | 'idle';

export class InUseError extends Error {
  constructor(public terminal: TerminalInfo) {
    super('This session is open in a terminal');
  }
}

type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

export type PendingView = {
  id: string;
  kind: 'permission' | 'question';
  toolName: string;
  title: string;
  description?: string;
  summary: string;
  canAlways: boolean;
  questions?: Question[];
};

type Pending = PendingView & {
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
};

/** A background agent, shell or workflow the session has running. */
export type BgTask = {
  id: string;
  type: string;
  description: string;
  startedAt: number;
  lastTool?: string;
  summary?: string;
  toolUses?: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  status: Status;
  live: boolean;
  lastActivity: number;
  lastText?: string;
  pending: PendingView[];
  tasks?: BgTask[];
  /** Set when another process (usually a terminal) has this session open. */
  terminal?: TerminalInfo;
};

export type Decision = 'allow' | 'always' | 'deny';

class LiveSession {
  q?: Query;
  input?: AsyncQueue<SDKUserMessage>;
  running = false;
  events: UIEvent[] = [];
  pending = new Map<string, Pending>();
  tasks = new Map<string, BgTask>();
  lastActivity = Date.now();
  constructor(public id: string, public cwd: string, public title: string) {}

  get status(): Status {
    if (this.pending.size) return 'needs_you';
    if (this.running) return 'working';
    return 'done';
  }

  get lastText() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind === 'assistant') return e.text.slice(0, 160);
      if (e.kind === 'tool') return `${e.name} ${e.summary}`.slice(0, 160);
    }
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      live: true,
      lastActivity: this.lastActivity,
      lastText: this.lastText,
      pending: [...this.pending.values()].map(({ input, suggestions, resolve, ...view }) => view),
      tasks: [...this.tasks.values()],
    };
  }
}

export type Broadcast = (msg: unknown) => void;
export type Notify = (n: PushPayload) => void;

const project = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? '~';

export class SessionManager {
  private live = new Map<string, LiveSession>();

  constructor(private broadcast: Broadcast, private notify: Notify = () => {}) {
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  /** With `dir`, only that project's sessions. The SDK includes its git worktrees; pass their paths so live ones count too. */
  async list(dir?: string, worktreePaths: string[] = []): Promise<SessionSummary[]> {
    const [disk, term] = await Promise.all([listSessions({ dir, limit: dir ? 40 : 60 }), terminalSessions()]);
    const out = new Map<string, SessionSummary>();
    for (const s of disk) {
      out.set(s.sessionId, {
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || '(untitled)',
        cwd: s.cwd ?? '',
        status: 'idle',
        live: false,
        lastActivity: s.lastModified,
        pending: [],
      });
    }
    for (const s of this.live.values()) {
      if (!dir || out.has(s.id) || [dir, ...worktreePaths].some((d) => s.cwd === d || s.cwd.startsWith(d + '/'))) out.set(s.id, s.summary());
    }
    for (const [id, t] of term) {
      const s = out.get(id);
      if (!s) continue;
      s.terminal = t;
      if (!s.live) s.status = 'terminal';
    }
    const rank: Record<Status, number> = { needs_you: 0, working: 1, terminal: 2, done: 3, idle: 4 };
    return [...out.values()].sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
  }

  async detail(id: string): Promise<{ session: SessionSummary; events: UIEvent[] } | undefined> {
    const terminal = (await terminalSessions()).get(id);
    const s = this.live.get(id);
    if (s) return { session: { ...s.summary(), terminal }, events: s.events };
    const info = await getSessionInfo(id);
    if (!info) return undefined;
    return {
      session: {
        id,
        title: info.customTitle || info.summary || '(untitled)',
        cwd: info.cwd ?? '',
        status: terminal ? 'terminal' : 'idle',
        live: false,
        lastActivity: info.lastModified,
        pending: [],
        terminal,
      },
      events: await this.loadHistory(id),
    };
  }

  async cwdOf(id: string): Promise<string | undefined> {
    return this.live.get(id)?.cwd ?? (await getSessionInfo(id))?.cwd;
  }

  async create(cwd: string, prompt: string, images: ImageInput[] = []): Promise<string> {
    const id = randomUUID();
    const s = new LiveSession(id, cwd, prompt.split('\n')[0].slice(0, 80) || '(image)');
    this.live.set(id, s);
    this.start(s, { sessionId: id });
    this.pushPrompt(s, prompt, images);
    return id;
  }

  /** Throws InUseError when another process (a terminal) has the session open, unless forced. */
  async send(id: string, text: string, force = false, images: ImageInput[] = []) {
    if (!force) {
      const t = (await terminalSessions()).get(id);
      if (t) throw new InUseError(t);
    }
    let s = this.live.get(id);
    if (!s) {
      const info = await getSessionInfo(id);
      if (!info?.cwd) throw new Error('session not found');
      s = new LiveSession(id, info.cwd, info.customTitle || info.summary || '(untitled)');
      s.events = await this.loadHistory(id);
      this.live.set(id, s);
    }
    if (!s.q) this.start(s, { resume: id });
    this.pushPrompt(s, text, images);
  }

  async rename(id: string, title: string) {
    await renameSession(id, title);
    const s = this.live.get(id);
    if (s) {
      s.title = title;
      this.touch(s);
    }
  }

  /** Saves a chat's overrides and applies them to its running query, if any. */
  async updateChat(id: string, patch: unknown) {
    const own = await updateChatSettings(id, patch);
    const q = this.live.get(id)?.q;
    if (q) {
      const { model, effort, permissionMode } = effectiveSettings(id);
      await q.setModel(model || undefined);
      await q.applyFlagSettings({ effortLevel: effort || null });
      await q.setPermissionMode(permissionMode);
    }
    return own;
  }

  respond(id: string, requestId: string, decision: Decision, answers?: Record<string, string>) {
    const s = this.live.get(id);
    const p = s?.pending.get(requestId);
    if (!s || !p) throw new Error('no such request');
    s.pending.delete(requestId);
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'The user denied this from the pouch app.' });
    } else {
      p.resolve({
        behavior: 'allow',
        updatedInput: answers ? { ...p.input, answers } : p.input,
        updatedPermissions: decision === 'always' && p.canAlways ? p.suggestions : undefined,
      });
    }
    this.touch(s);
  }

  async stopTask(id: string, taskId: string) {
    const q = this.live.get(id)?.q;
    if (!q) throw new Error('session not running');
    await q.stopTask(taskId);
  }

  async interrupt(id: string) {
    const s = this.live.get(id);
    if (!s?.q) return;
    for (const p of s.pending.values()) p.resolve({ behavior: 'deny', message: 'Interrupted by the user.', interrupt: true });
    s.pending.clear();
    await s.q.interrupt();
    this.touch(s);
  }

  /** Stops a session's process to free its memory; the next message resumes it. */
  end(id: string) {
    const s = this.live.get(id);
    if (!s) return;
    for (const p of s.pending.values()) p.resolve({ behavior: 'deny', message: 'Session ended by the user.' });
    s.pending.clear();
    this.close(s);
  }

  private start(s: LiveSession, opts: { sessionId?: string; resume?: string }) {
    const input = new AsyncQueue<SDKUserMessage>();
    const env = claudeEnv();
    const { model, effort, permissionMode } = effectiveSettings(s.id);
    this.makeRoom(s);
    s.tasks.clear(); // background tasks die with the old process
    const q = query({
      prompt: input,
      options: {
        ...opts,
        cwd: s.cwd,
        // Omitting systemPrompt gives an empty one; use Claude Code's own so sessions get
        // the same environment, git, CLAUDE.md and memory context as the terminal.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // In 'auto' a classifier approves or denies each tool call; only calls it can't decide reach canUseTool.
        permissionMode,
        model: model || undefined,
        effort: effort || undefined,
        // Flag-layer settings: only this process sees them; ~/.claude.json and terminals are untouched.
        settings: { deniedMcpServers: settings().mcpOff.map((serverName) => ({ serverName })) },
        canUseTool: this.canUseTool(s),
        env,
        stderr: (d) => console.error(`[${s.id.slice(0, 8)}] ${d.trimEnd()}`),
      },
    });
    s.q = q;
    s.input = input;
    this.consume(s, q);
  }

  private async consume(s: LiveSession, q: Query) {
    try {
      for await (const m of q) this.handle(s, m);
    } catch (err) {
      this.addEvent(s, { kind: 'error', id: randomUUID(), text: String((err as Error)?.message ?? err) });
    } finally {
      if (s.q === q) {
        s.q = undefined;
        s.input = undefined;
        s.running = false;
        for (const p of s.pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed.' });
        s.pending.clear();
        s.tasks.clear();
        this.touch(s);
      }
    }
  }

  private handle(s: LiveSession, m: SDKMessage) {
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      // A finished background task can start a turn on its own, without a prompt from us.
      if (!s.running) {
        s.running = true;
        this.touch(s);
      }
      for (const e of fromApiMessage(m.uuid, 'assistant', m.message as never)) this.addEvent(s, e);
    } else if (m.type === 'user' && !m.parent_tool_use_id) {
      // Our own prompts are recorded when sent; only tool results come back from here.
      for (const e of fromApiMessage(m.uuid ?? randomUUID(), 'user', m.message as never)) {
        if (e.kind === 'tool_result') this.addEvent(s, e);
      }
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      // The full set every time; keep what task_progress told us about tasks still running.
      const prev = s.tasks;
      s.tasks = new Map(
        m.tasks.filter((t) => !t.ambient).map((t) => [t.task_id, prev.get(t.task_id) ?? {
          id: t.task_id,
          type: t.task_type === 'local_agent' ? (t.subagent_type ?? 'agent') : t.task_type === 'local_bash' ? 'shell' : t.task_type.replace(/^local_/, ''),
          description: t.description,
          startedAt: Date.now(),
        }]),
      );
      this.touch(s);
    } else if (m.type === 'system' && m.subtype === 'task_progress') {
      const t = s.tasks.get(m.task_id);
      if (t) {
        t.lastTool = m.last_tool_name;
        t.summary = m.summary;
        t.toolUses = m.usage.tool_uses;
        t.startedAt = Date.now() - m.usage.duration_ms;
        this.touch(s);
      }
    } else if (m.type === 'result') {
      s.running = false;
      const ok = m.subtype === 'success' && !m.is_error;
      this.addEvent(s, {
        kind: 'result',
        id: m.uuid,
        ok,
        text: ok ? undefined : 'errors' in m ? m.errors?.join('\n') : undefined,
        costUsd: m.total_cost_usd,
        durationMs: m.duration_ms,
      });
      if (!s.pending.size && settings().notify[ok ? 'done' : 'failed']) {
        this.notify({
          title: `${project(s.cwd)} · ${ok ? 'done' : 'failed'}${s.tasks.size ? ` · ${s.tasks.size} in background` : ''}`,
          body: s.lastText ?? s.title,
          url: `/#/s/${s.id}`,
          tag: s.id,
        });
      }
    }
  }

  private canUseTool(s: LiveSession): CanUseTool {
    return (toolName, input, opts) =>
      new Promise<PermissionResult>((resolve) => {
        const isQuestion = toolName === 'AskUserQuestion';
        const p: Pending = {
          id: opts.requestId || randomUUID(),
          kind: isQuestion ? 'question' : 'permission',
          toolName,
          title: opts.title ?? `Claude wants to use ${toolName}`,
          description: opts.description ?? opts.decisionReason,
          summary: toolSummary(toolName, input),
          canAlways: !opts.suppressAlwaysAllowRule && !!opts.suggestions?.length,
          questions: isQuestion ? (input.questions as Question[]) : undefined,
          input,
          suggestions: opts.suggestions,
          resolve,
        };
        s.pending.set(p.id, p);
        if (settings().notify.needsYou) this.notify({
          title: `${project(s.cwd)} · needs you`,
          body: isQuestion ? (p.questions?.[0]?.question ?? 'Claude has a question') : `${p.title}\n${p.summary}`,
          url: `/#/s/${s.id}`,
          tag: s.id,
          respond: isQuestion ? undefined : { sessionId: s.id, requestId: p.id, canAlways: p.canAlways },
        });
        opts.signal.addEventListener('abort', () => {
          if (s.pending.delete(p.id)) {
            resolve({ behavior: 'deny', message: 'Aborted.' });
            this.touch(s);
          }
        });
        this.touch(s);
      });
  }

  private pushPrompt(s: LiveSession, text: string, images: ImageInput[] = []) {
    s.running = true;
    const uuid = randomUUID(); // shared with the transcript
    this.addEvent(s, {
      kind: 'user',
      id: uuid,
      text,
      images: images.length ? images.map((i) => `data:${i.mediaType};base64,${i.data}`) : undefined,
    });
    const content = images.length
      ? [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
          ...(text ? [{ type: 'text', text }] : []),
        ]
      : text;
    s.input!.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage);
  }

  private async loadHistory(id: string): Promise<UIEvent[]> {
    const msgs = await getSessionMessages(id);
    return msgs
      .filter((m) => !m.parent_tool_use_id && m.type !== 'system')
      .flatMap((m) => fromApiMessage(m.uuid, m.type, m.message as never));
  }

  private addEvent(s: LiveSession, e: UIEvent) {
    s.events.push(e);
    this.broadcast({ type: 'event', sessionId: s.id, event: e });
    this.touch(s);
  }

  private touch(s: LiveSession) {
    s.lastActivity = Date.now();
    this.broadcast({ type: 'session', session: s.summary() });
  }

  private reapIdle() {
    const idleMs = settings().idleCloseMin * 60_000;
    if (!idleMs) return;
    for (const s of this.live.values()) {
      if (this.closable(s) && Date.now() - s.lastActivity >= idleMs) this.close(s);
    }
  }

  /** Before `next` starts a process, closes the longest-idle sessions to stay under the limit. */
  private makeRoom(next: LiveSession) {
    const max = settings().maxLive;
    if (!max) return;
    const running = [...this.live.values()].filter((s) => s.q && s !== next);
    const idle = running.filter((s) => this.closable(s)).sort((a, b) => a.lastActivity - b.lastActivity);
    for (let n = running.length; n >= max && idle.length; n--) this.close(idle.shift()!);
  }

  private closable(s: LiveSession) {
    return !s.running && !s.pending.size && !s.tasks.size;
  }

  private close(s: LiveSession) {
    const { q, input } = s;
    s.q = s.input = undefined; // detach first so consume() doesn't re-broadcast
    input?.close();
    q?.close();
    this.live.delete(s.id);
    this.broadcast({ type: 'session', session: { ...s.summary(), status: 'idle', live: false } });
  }
}
