import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

// Cloudflare Access in front of a Cloudflare Tunnel. Cloudflare signs every request it lets through
// with a JWT; checking it here means the tunnel alone (or an Access rule set up wrong) can't open pouch.
// POUCH_CF_ACCESS_TEAM is the team domain (<team>.cloudflareaccess.com), POUCH_CF_ACCESS_AUD the
// application's AUD tag.
const TEAM = (process.env.POUCH_CF_ACCESS_TEAM ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
const AUD = (process.env.POUCH_CF_ACCESS_AUD ?? '').trim();
export const accessEnabled = Boolean(TEAM && AUD);
if ((TEAM || AUD) && !accessEnabled) throw new Error('set both POUCH_CF_ACCESS_TEAM and POUCH_CF_ACCESS_AUD');

let keys = new Map<string, KeyObject>();
let fetchedAt = 0;

async function refreshKeys() {
  // Keys rotate; refetch on an unknown kid, but at most once a minute.
  if (Date.now() - fetchedAt < 60_000) return;
  fetchedAt = Date.now();
  const res = await fetch(`https://${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`access certs: HTTP ${res.status}`);
  const { keys: jwks } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  keys = new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function validAccessJwt(jwt: unknown): Promise<boolean> {
  if (typeof jwt !== 'string') return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = b64json(parts[0]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    if (!keys.has(header.kid)) await refreshKeys().catch((e) => console.warn(String(e)));
    const key = keys.get(header.kid);
    if (!key) return false;
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, parts[2], 'base64url');
    if (!ok) return false;
    const claims = b64json(parts[1]);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    return aud.includes(AUD) && claims.iss === `https://${TEAM}` && typeof claims.exp === 'number' && claims.exp > now
      && (typeof claims.nbf !== 'number' || claims.nbf <= now + 60);
  } catch {
    return false;
  }
}

// Cloudflare always sets CF-Connecting-IP and a client can't strip it, so its presence means the request
// came through the tunnel. Requests over tailscale serve or localhost don't have it and aren't affected.
export const viaCloudflare = (req: FastifyRequest) => req.headers['cf-connecting-ip'] !== undefined;

export const accessJwt = (req: FastifyRequest) => req.headers['cf-access-jwt-assertion'];
