import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { DATA_DIR } from './push.js';

const FILE = join(DATA_DIR, 'settings.json');

export const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'] as const; // '' = SDK default
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// bypassPermissions is left out on purpose: pouch runs unattended on a phone.
export const PERMISSION_MODES = ['auto', 'default', 'acceptEdits'] as const;

// Environment for anything that runs claude. ANTHROPIC_API_KEY is dropped so a stray key never
// overrides the plan login, unless POUCH_USE_API_KEY=1 asks for API billing.
export function claudeEnv(extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...extra };
  if (process.env.POUCH_USE_API_KEY !== '1') delete env.ANTHROPIC_API_KEY;
  return env;
}

export type Settings = {
  model: (typeof MODELS)[number];
  effort: '' | EffortLevel;
  permissionMode: (typeof PERMISSION_MODES)[number];
  /** Minutes before an idle live session is closed; 0 = never. */
  idleCloseMin: number;
  /** Most sessions kept running at once (each is a ~250 MB claude process); 0 = no limit. */
  maxLive: number;
  /** MCP servers (by name) left out of sessions, so their tools stay out of the context. */
  mcpOff: string[];
  notify: { needsYou: boolean; done: boolean; failed: boolean };
};

const DEFAULTS: Settings = {
  model: '',
  effort: '',
  permissionMode: 'auto',
  idleCloseMin: 10,
  maxLive: 4,
  mcpOff: [],
  notify: { needsYou: true, done: true, failed: true },
};

let current: Settings = DEFAULTS;

/** Keeps known keys with valid values, falling back to `base` for the rest. */
function clean(input: any, base: Settings): Settings {
  const pick = <T>(v: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(v as T) ? (v as T) : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const n = input?.notify ?? {};
  const idle = Number(input?.idleCloseMin);
  const maxLive = Number(input?.maxLive);
  const mcpOff = input?.mcpOff;
  return {
    model: pick(input?.model, MODELS, base.model),
    effort: pick(input?.effort, EFFORTS, base.effort),
    permissionMode: pick(input?.permissionMode, PERMISSION_MODES, base.permissionMode),
    idleCloseMin: Number.isInteger(idle) && idle >= 0 && idle <= 24 * 60 ? idle : base.idleCloseMin,
    maxLive: Number.isInteger(maxLive) && maxLive >= 0 && maxLive <= 50 ? maxLive : base.maxLive,
    mcpOff: Array.isArray(mcpOff) && mcpOff.length <= 100 && mcpOff.every((n) => typeof n === 'string' && n && n.length <= 200)
      ? [...new Set<string>(mcpOff)]
      : base.mcpOff,
    notify: {
      needsYou: bool(n.needsYou, base.notify.needsYou),
      done: bool(n.done, base.notify.done),
      failed: bool(n.failed, base.notify.failed),
    },
  };
}

export async function loadSettings() {
  try {
    current = clean(JSON.parse(await readFile(FILE, 'utf8')), DEFAULTS);
  } catch {
    current = DEFAULTS;
  }
}

export const settings = () => current;

export async function updateSettings(patch: unknown) {
  current = clean({ ...current, ...(patch as object), notify: { ...current.notify, ...(patch as any)?.notify } }, current);
  await writeFile(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  return current;
}

// ---------- per-chat overrides ----------
// Keyed by session id. '' (or a missing key) means "use the app setting".

const CHATS_FILE = join(DATA_DIR, 'chats.json');

export type ChatSettings = Partial<Pick<Settings, 'model' | 'effort' | 'permissionMode'>>;

let chats: Record<string, ChatSettings> = {};

function cleanChat(input: any): ChatSettings {
  const out: ChatSettings = {};
  if (MODELS.includes(input?.model) && input.model) out.model = input.model;
  if (EFFORTS.includes(input?.effort) && input.effort) out.effort = input.effort;
  if (PERMISSION_MODES.includes(input?.permissionMode)) out.permissionMode = input.permissionMode;
  return out;
}

export async function loadChatSettings() {
  try {
    const raw = JSON.parse(await readFile(CHATS_FILE, 'utf8'));
    chats = Object.fromEntries(Object.entries(raw).map(([id, c]) => [id, cleanChat(c)]));
  } catch {
    chats = {};
  }
}

export const chatSettings = (id: string): ChatSettings => chats[id] ?? {};

/** What a session actually runs with: its overrides on top of the app settings. */
export function effectiveSettings(id: string) {
  const { model, effort, permissionMode } = current;
  return { model, effort, permissionMode, ...chatSettings(id) };
}

/** Fields set to '' or null go back to following the app setting. */
export async function updateChatSettings(id: string, patch: unknown) {
  const merged: any = { ...chats[id], ...(patch as object) };
  for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] === null) delete merged[k];
  const next = cleanChat(merged);
  if (Object.keys(next).length) chats[id] = next;
  else delete chats[id];
  await writeFile(CHATS_FILE, JSON.stringify(chats, null, 2), { mode: 0o600 });
  return chatSettings(id);
}
