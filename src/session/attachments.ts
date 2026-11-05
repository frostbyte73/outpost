// Photos go inline as images (what the CLI sends for a paste); any other file is saved and
// its path handed to the model, so Read handles every type without Outpost knowing them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TurnInput } from '../runtime/types.js';

export interface Attachment {
  kind: 'image' | 'file';
  name: string;
  mediaType: string;
  data: string; // base64
}

export const MAX_ATTACHMENTS = 10;
const MB = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * MB;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 30 * MB;
// The API refuses an image over 5 MB of base64, and a refused image in history fails every later turn
export const MAX_IMAGE_BYTES = 3.75 * MB;
// Base64 of the per-message cap, plus room for the text; server.ts sizes the WS maxPayload to this
export const MAX_USER_MESSAGE_FRAME_BYTES = Math.ceil(MAX_MESSAGE_ATTACHMENT_BYTES * 4 / 3) + 8 * MB;
export const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// mediaType is shown to the model verbatim, so nothing that could end the line or the parenthetical
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export const uploadsRootFor = (runtimeDir: string) => join(runtimeDir, 'uploads');

const fmtLimit =(n: number) => `${+(n / MB).toFixed(2)} MB`;

// Throws with a message fit to show the user. An absent field is no attachments.
export function parseAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be a list');
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message`);
  let total = 0;
  return raw.map((a, i) => {
    const { kind, name, mediaType, data } = (a ?? {}) as Record<string, unknown>;
    const label = typeof name === 'string' && name ? name : `attachment ${i + 1}`;
    if (kind !== 'image' && kind !== 'file') throw new Error(`${label}: unknown attachment kind`);
    if (typeof data !== 'string' || !data || !BASE64.test(data)) throw new Error(`${label}: not base64 data`);
    const bytes = Math.floor(data.length * 3 / 4);
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    if (bytes > limit) throw new Error(`${label}: larger than ${fmtLimit(limit)}${kind === 'image' ? ' — send it as a file instead' : ''}`);
    total += bytes;
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(`attachments are limited to ${fmtLimit(MAX_MESSAGE_ATTACHMENT_BYTES)} per message`);
    const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : '';
    if (kind === 'image' && !IMAGE_MEDIA_TYPES.has(type)) throw new Error(`${label}: unsupported image type ${type || '(none)'}`);
    return { kind, name: label, mediaType: MEDIA_TYPE.test(type) ? type : 'application/octet-stream', data };
  });
}

// The name only ever becomes the last path segment, and never a dotfile or a traversal.
export function safeFileName(name: string): string {
  const cleaned = basename(name).replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}

// Returns where the file landed. Files are per-session so one session's uploads never shadow
// another's, and timestamped so two `IMG_0001.jpeg`s sent a minute apart both survive.
export function makeUploadSaver(uploadsRoot: string, sessionId: string, now = Date.now): (a: Attachment, index: number) => string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('invalid session id');
  const dir = join(uploadsRoot, sessionId);
  return (a, index) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${now()}-${index}-${safeFileName(a.name)}`);
    writeFileSync(path, Buffer.from(a.data, 'base64'), { mode: 0o600 });
    return path;
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function buildTurnInput(text: string, attachments: Attachment[], save: (a: Attachment, index: number) => string): TurnInput {
  if (attachments.length === 0) return { text };
  const fileLines = attachments.flatMap((a, i) => {
    if (a.kind !== 'file') return [];
    const path = save(a, i);
    return [`[Attached file: ${path} (${a.mediaType}, ${fmtBytes(Buffer.byteLength(a.data, 'base64'))})]`];
  });
  const fullText = [text, ...fileLines].filter(Boolean).join('\n\n');
  const images = attachments.filter((a) => a.kind === 'image');
  if (images.length === 0) return { text: fullText };
  return { text: fullText, images: images.map((a) => ({ mediaType: a.mediaType, data: a.data })) };
}
