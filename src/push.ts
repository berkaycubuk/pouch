import webpush, { type PushSubscription } from 'web-push';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = process.env.POUCH_DATA ?? join(homedir(), '.config', 'pouch');
const KEYS_FILE = join(DATA_DIR, 'vapid.json');
const SUBS_FILE = join(DATA_DIR, 'subscriptions.json');

export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  // Present when the notification can answer a permission prompt directly.
  respond?: { sessionId: string; requestId: string; canAlways: boolean };
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Push {
  private subs: PushSubscription[] = [];
  publicKey = '';

  async init() {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    let keys = await readJson<{ publicKey: string; privateKey: string } | null>(KEYS_FILE, null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await writeFile(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
    }
    webpush.setVapidDetails('mailto:pouch@localhost', keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    this.subs = await readJson<PushSubscription[]>(SUBS_FILE, []);
  }

  async subscribe(sub: PushSubscription) {
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), sub];
    await this.save();
  }

  async unsubscribe(endpoint: string) {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    await this.save();
  }

  has(endpoint: string) {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  async send(payload: PushPayload) {
    const body = JSON.stringify(payload);
    const gone: string[] = [];
    await Promise.all(
      this.subs.map((s) =>
        webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high' }).catch((err) => {
          // 404/410: the browser dropped this subscription.
          if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(s.endpoint);
          else console.error('push failed', err?.statusCode, err?.body ?? err);
        }),
      ),
    );
    if (gone.length) {
      this.subs = this.subs.filter((s) => !gone.includes(s.endpoint));
      await this.save();
    }
  }

  private save() {
    return writeFile(SUBS_FILE, JSON.stringify(this.subs), { mode: 0o600 });
  }
}
