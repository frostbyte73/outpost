import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// VAPID requires a subject (mailto: or https:); we don't expose a real inbox.
// No rotation: rotating invalidates every subscribed device.
const DEFAULT_SUBJECT = 'mailto:outpost@localhost';

export function loadOrCreateVapid(path: string): VapidKeys {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>;
    if (!parsed.publicKey || !parsed.privateKey) {
      throw new Error(`vapid.json missing publicKey/privateKey: ${path}`);
    }
    return {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      subject: parsed.subject ?? DEFAULT_SUBJECT,
    };
  }
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const keys: VapidKeys = { publicKey, privateKey, subject: DEFAULT_SUBJECT };
  writeFileSync(path, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return keys;
}
