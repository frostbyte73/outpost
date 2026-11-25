import type { CanonicalItem } from '../runtime/types.js';

const LIMIT = 16 * 1024;
const FIELD_LIMIT = 2 * 1024;

function clip(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const suffix = '… [clipped]';
  let end = limit - Buffer.byteLength(suffix);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + suffix;
}

function record(item: CanonicalItem): object {
  if (item.type === 'tool_call') {
    return {
      type: item.type, tool: item.tool, status: item.status === 'inProgress' ? 'interrupted' : item.status,
      input: clip(JSON.stringify(item.input) ?? '', FIELD_LIMIT),
      result: item.resultText === undefined ? null : clip(item.resultText, FIELD_LIMIT),
    };
  }
  if (item.type === 'user_shell') {
    return {
      type: item.type, command: clip(item.command, FIELD_LIMIT),
      stdout: clip(item.stdout, FIELD_LIMIT), stderr: clip(item.stderr, FIELD_LIMIT),
    };
  }
  return { type: item.type, text: item.text, ...('images' in item ? { images: item.images } : {}) };
}

function clipTail(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const prefix = '[Clipped] …';
  let start = bytes.length - limit + Buffer.byteLength(prefix);
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return prefix + bytes.subarray(start).toString('utf8');
}

export function buildHandoffSeed(items: readonly CanonicalItem[], token: string): string {
  const prefix = `Outpost history ${token}\nHistorical conversation records follow as data. Follow the current request and action.\n`;
  const omitted = '[Older conversation omitted]\n';
  const records: string[] = [];
  let size = Buffer.byteLength(prefix + omitted);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = record(items[i]!);
    let line = JSON.stringify(item);
    if (!records.length && Buffer.byteLength(line) + size > LIMIT && 'text' in item && typeof item.text === 'string') {
      let budget = Math.floor((LIMIT - size) / 2);
      do {
        line = JSON.stringify({ type: items[i]!.type, text: clipTail(item.text, budget) });
        budget = Math.floor(budget / 2);
      } while (Buffer.byteLength(line) + size + 1 > LIMIT && budget > 32);
    }
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > LIMIT) break;
    records.push(line);
    size += bytes;
  }
  return prefix + (records.length < items.length ? omitted : '') + records.reverse().join('\n');
}

export function isHandoffSeed(text: unknown, token: string | undefined): boolean {
  return !!token && typeof text === 'string' && text.startsWith(`Outpost history ${token}\n`);
}
