// Converts SDK / transcript messages into the small set of events the phone UI renders.

export type UIEvent =
  | { kind: 'user'; id: string; text: string; images?: string[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; diff?: string }
  | { kind: 'tool_result'; id: string; toolUseId: string; isError: boolean; output: string; images?: string[] }
  | { kind: 'result'; id: string; ok: boolean; text?: string; costUsd?: number; durationMs?: number }
  | { kind: 'error'; id: string; text: string };

const MAX_OUTPUT = 4000;

type Block = { type: string; [k: string]: unknown };
type ApiMessage = { role?: string; content?: string | Block[] };

function clip(s: string, n = MAX_OUTPUT) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

// Text Claude Code injects into user turns that a person never typed.
function isInjected(text: string) {
  const t = text.trimStart();
  return /^<(system-reminder|local-command|command-name|command-message|command-args)/.test(t) || t.startsWith('Caveat:');
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const s =
    pick('command') ?? pick('file_path') ?? pick('notebook_path') ?? pick('pattern') ?? pick('url') ??
    pick('query') ?? pick('description') ?? pick('prompt') ?? pick('skill');
  if (s) return s.split('\n')[0].slice(0, 200);
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json.slice(0, 200);
}

const lines = (text: unknown, prefix: string) =>
  String(text ?? '').split('\n').map((l) => prefix + l).join('\n');

/** A small unified-style diff for file-editing tools, shown when the tool row is expanded. */
export function toolDiff(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Edit') return clip(`${lines(input.old_string, '-')}\n${lines(input.new_string, '+')}`);
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return clip(
      input.edits
        .map((e: Record<string, unknown>) => `${lines(e.old_string, '-')}\n${lines(e.new_string, '+')}`)
        .join('\n@@\n'),
    );
  }
  if (name === 'Write') return clip(lines(input.content, '+'));
}

function imageSrc(b: Block): string | undefined {
  const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (src?.type === 'base64' && src.data) return `data:${src.media_type};base64,${src.data}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Block) => !(b.type === 'image' && imageSrc(b)))
      .map((b: Block) => (b.type === 'text' ? String(b.text) : `[${b.type}]`))
      .join('\n');
  }
  return '';
}

function resultImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return;
  const images = content.flatMap((b: Block) => (b.type === 'image' && imageSrc(b)) || []);
  return images.length ? images : undefined;
}

/** Events for one API-shaped message (assistant or user role). */
export function fromApiMessage(msgId: string, role: string, message: ApiMessage): UIEvent[] {
  const out: UIEvent[] = [];
  const content = message?.content;
  if (typeof content === 'string') {
    if (content.trim() && !isInjected(content)) {
      out.push({ kind: role === 'assistant' ? 'assistant' : 'user', id: msgId, text: content });
    }
    return out;
  }
  if (!Array.isArray(content)) return out;
  const images: string[] = [];
  content.forEach((b, i) => {
    const id = `${msgId}:${i}`;
    if (b.type === 'text') {
      const text = String(b.text ?? '');
      if (!text.trim() || (role === 'user' && isInjected(text))) return;
      out.push({ kind: role === 'assistant' ? 'assistant' : 'user', id, text });
    } else if (b.type === 'image' && role === 'user') {
      const src = imageSrc(b);
      if (src) images.push(src);
    } else if (b.type === 'tool_use') {
      const input = (b.input ?? {}) as Record<string, unknown>;
      const name = String(b.name);
      out.push({ kind: 'tool', id: String(b.id), name, summary: toolSummary(name, input), diff: toolDiff(name, input) });
    } else if (b.type === 'tool_result') {
      out.push({
        kind: 'tool_result',
        id,
        toolUseId: String(b.tool_use_id),
        isError: Boolean(b.is_error),
        output: clip(resultText(b.content)),
        images: resultImages(b.content),
      });
    }
  });
  if (images.length) {
    // Show a message's images in its (first) text bubble, or in a bubble of their own.
    const u = out.find((e) => e.kind === 'user');
    if (u && u.kind === 'user') u.images = images;
    else out.unshift({ kind: 'user', id: `${msgId}:img`, text: '', images });
  }
  return out;
}

export type ImageInput = { mediaType: string; data: string };

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API's per-image limit

/** Validates images uploaded by the client; returns an error message or undefined. */
export function checkImages(images: unknown): string | undefined {
  if (images === undefined) return;
  if (!Array.isArray(images)) return 'images must be an array';
  if (images.length > MAX_IMAGES) return `at most ${MAX_IMAGES} images per message`;
  for (const img of images as ImageInput[]) {
    if (!IMAGE_TYPES.has(img?.mediaType)) return 'images must be PNG, JPEG, GIF or WebP';
    if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(img.data)) return 'image data must be base64';
    if (Buffer.byteLength(img.data, 'base64') > MAX_IMAGE_BYTES) return 'images must be under 5 MB each';
  }
}
