import { describe, it, expect } from 'vitest';
import { shellEscape } from '../shell-escape';

/**
 * shellEscape is the single guard that lets untrusted/agent-supplied paths and
 * queries be interpolated into `sh -lc` commands inside the sandbox. These
 * tests lock its semantics exactly: a value is wrapped in single quotes (which
 * makes the shell treat every character literally) and the only special case --
 * an embedded single quote -- is closed, escaped, and reopened (`'\''`).
 */
describe('shellEscape', () => {
  it('wraps a benign value in single quotes', () => {
    expect(shellEscape('package.json')).toBe(`'package.json'`);
    expect(shellEscape('src/app/main.ts')).toBe(`'src/app/main.ts'`);
  });

  it('escapes an embedded single quote with the close/escape/reopen idiom', () => {
    // a'b -> 'a'\''b'
    expect(shellEscape(`a'b`)).toBe(`'a'\\''b'`);
  });

  it('neutralizes a quote-breakout injection payload', () => {
    // a'; rm -rf /; '  ->  'a'\''; rm -rf /; '\'''
    expect(shellEscape(`a'; rm -rf /; '`)).toBe(`'a'\\''; rm -rf /; '\\'''`);
  });

  it('quotes command-substitution, pipes, redirects, and newlines without altering them', () => {
    expect(shellEscape('$(id)')).toBe(`'$(id)'`);
    expect(shellEscape('`whoami`')).toBe("'`whoami`'");
    expect(shellEscape('a && b | c > d < e')).toBe(`'a && b | c > d < e'`);
    expect(shellEscape('a\nrm -rf /')).toBe(`'a\nrm -rf /'`);
    expect(shellEscape('a & background')).toBe(`'a & background'`);
  });

  it('handles empty string and a lone quote', () => {
    expect(shellEscape('')).toBe(`''`);
    // a single quote becomes the escape sequence between two empty quoted runs.
    expect(shellEscape(`'`)).toBe(`''\\'''`);
  });

  it('always produces a single-quoted run (invariant for any input)', () => {
    for (const s of ['', 'x', `a'b`, '$(id)', 'a;b|c', "multiple ' quotes ' here"]) {
      const out = shellEscape(s);
      expect(out.startsWith(`'`)).toBe(true);
      expect(out.endsWith(`'`)).toBe(true);
      // Every literal quote from the input is represented as the 4-char `'\''`
      // sequence; none survive as a bare breakout quote.
      const bareQuotes = (s.match(/'/g) ?? []).length;
      const escapeSeqs = (out.match(/'\\''/g) ?? []).length;
      expect(escapeSeqs).toBe(bareQuotes);
    }
  });
});
