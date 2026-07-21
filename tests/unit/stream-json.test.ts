import { describe, it, expect } from 'vitest';
import { LineParser } from '../../src/session/stream-json.js';

describe('LineParser', () => {
  it('emits complete lines as JSON objects', () => {
    const parser = new LineParser();
    const out: unknown[] = [];
    parser.onLine = (obj) => out.push(obj);
    parser.write('{"a":1}\n{"b":2}\n');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('buffers across writes when a line is split', () => {
    const parser = new LineParser();
    const out: unknown[] = [];
    parser.onLine = (obj) => out.push(obj);
    parser.write('{"a":');
    parser.write('1}\n');
    expect(out).toEqual([{ a: 1 }]);
  });

  it('does not emit on partial input with no newline', () => {
    const parser = new LineParser();
    const out: unknown[] = [];
    parser.onLine = (obj) => out.push(obj);
    parser.write('{"incomplete":');
    expect(out).toEqual([]);
  });

  it('reports malformed lines via onError instead of throwing', () => {
    const parser = new LineParser();
    const errs: string[] = [];
    parser.onError = (raw) => errs.push(raw);
    parser.write('not-json\n');
    expect(errs).toEqual(['not-json']);
  });

  it('handles empty lines silently', () => {
    const parser = new LineParser();
    const out: unknown[] = [];
    parser.onLine = (obj) => out.push(obj);
    parser.write('\n\n{"a":1}\n');
    expect(out).toEqual([{ a: 1 }]);
  });
});
