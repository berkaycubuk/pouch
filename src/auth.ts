import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DATA_DIR } from './push.js';
import { viaCloudflare } from './access.js';

const FILE = join(DATA_DIR, 'token');
const COOKIE = 'pouch_token';
// Tailscale logins that skip the token. tailscale serve sets Tailscale-User-Login from the tailnet
// identity; only trust it from loopback, and only when nothing else proxies to pouch.
const TAILSCALE_USERS = (process.env.POUCH_TAILSCALE_USERS ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

let token: Buffer;

export async function loadToken() {
  const saved = (await readFile(FILE, 'utf8').catch(() => '')).trim();
  if (saved) {
    token = Buffer.from(saved);
  } else {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const t = randomBytes(32).toString('base64url');
    await writeFile(FILE, t + '\n', { mode: 0o600 });
    token = Buffer.from(t);
  }
  console.log(`pouch login token is in ${FILE}`);
}

export const validToken = (t: unknown) => {
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t);
  return b.length === token.length && timingSafeEqual(b, token);
};

const cookie = (req: FastifyRequest, name: string) =>
  req.headers.cookie?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

export function authorized(req: FastifyRequest) {
  if (validToken(cookie(req, COOKIE))) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (validToken(bearer)) return true;
  const login = req.headers['tailscale-user-login'];
  // cloudflared also proxies from loopback and passes client headers through, so never trust it there.
  return TAILSCALE_USERS.length > 0 && LOOPBACK.has(req.socket.remoteAddress ?? '') && !viaCloudflare(req)
    && typeof login === 'string' && TAILSCALE_USERS.includes(login.toLowerCase());
}

export function setLoginCookie(req: FastifyRequest, reply: FastifyReply) {
  const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  // 400 days is the longest browsers keep a cookie.
  reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${https ? '; Secure' : ''}`);
}

// QR login: a new device asks for a pairing and shows its QR code; a logged-in device scans it and
// approves, then the new device claims the cookie. The claim secret never leaves the new device.
type Pairing = { claim: string; agent: string; expires: number; approved: boolean };
const PAIR_MS = 5 * 60_000;
const pairings = new Map<string, Pairing>();

const prunePairings = () => {
  for (const [code, p] of pairings) if (p.expires < Date.now()) pairings.delete(code);
};

export function startPairing(req: FastifyRequest) {
  prunePairings();
  // Unauthenticated, so cap what strangers can pile up.
  if (pairings.size >= 20) return null;
  const code = randomBytes(16).toString('base64url');
  const claim = randomBytes(32).toString('base64url');
  pairings.set(code, { claim, agent: String(req.headers['user-agent'] ?? '').slice(0, 200), expires: Date.now() + PAIR_MS, approved: false });
  return { code, claim };
}

export const pairingInfo = (code: string) => {
  prunePairings();
  const p = pairings.get(code);
  return p && { agent: p.agent };
};

export function approvePairing(code: string) {
  prunePairings();
  const p = pairings.get(code);
  if (p) p.approved = true;
  return !!p;
}

// 'ok' once approved (the pairing is then used up), 'pending' until then, 'gone' if expired or unknown.
export function claimPairing(code: string, claim: unknown) {
  prunePairings();
  const p = pairings.get(code);
  if (!p || typeof claim !== 'string' || claim.length !== p.claim.length
    || !timingSafeEqual(Buffer.from(claim), Buffer.from(p.claim))) return 'gone';
  if (!p.approved) return 'pending';
  pairings.delete(code);
  return 'ok';
}
