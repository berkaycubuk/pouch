import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from './settings.js';

export type McpServer = { name: string; source?: string; status: string };

let cached: Promise<McpServer[]> | undefined;

/**
 * The MCP servers a session would load: user config, plugins and claude.ai connectors.
 * Asks a throwaway claude process that never gets a prompt, so it costs no tokens.
 * Project servers (.mcp.json) depend on the folder and aren't listed.
 */
export function mcpServers(refresh = false): Promise<McpServer[]> {
  if (!cached || refresh) {
    cached = probe();
    cached.catch(() => (cached = undefined));
  }
  return cached;
}

async function probe(): Promise<McpServer[]> {
  // A prompt stream that never yields keeps the process up without calling the API.
  const idle = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt: idle, options: { cwd: homedir(), env: claudeEnv() } });
  try {
    const list = await q.mcpServerStatus();
    return list.map((s) => ({ name: s.name, source: s.source ?? s.scope, status: s.status }));
  } finally {
    q.close();
  }
}
