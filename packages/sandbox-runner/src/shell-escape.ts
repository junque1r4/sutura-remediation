/**
 * POSIX single-quote shell escaping. Wrapping a string in single quotes makes
 * the shell treat every character literally; the only character that cannot
 * appear inside single quotes is a single quote itself, which we close, emit an
 * escaped quote (`'\''`), and reopen. This neutralizes every shell
 * metacharacter ($ ` ; | & > < ( ) newline ...) so untrusted/agent-supplied
 * paths and queries cannot break out of a `sh -lc` command.
 *
 * Single source of truth: docker-runner, scanners (including the Aikido local
 * scanner), and the fix-engine agent tools all import this rather than
 * re-implementing it, so the escaping is locked by one test instead of drifting
 * across copies.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
