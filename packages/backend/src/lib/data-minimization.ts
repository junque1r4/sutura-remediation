/**
 * Data minimization helpers.
 *
 * Pure functions (no side effects) used on write paths to avoid persisting
 * raw sensitive text, and on read paths to defensively scrub legacy rows.
 */

const REDACTED = '[REDACTED]';

/**
 * Patterns matching real secret shapes. Deliberately narrow (high minimum
 * lengths) so ordinary prose -- including short strings that merely start with
 * a known prefix -- is left untouched.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys: sk-ant-... (long random tail).
  /sk-ant-[A-Za-z0-9_-]{50,}/g,
  // GitHub fine-grained personal access tokens: github_pat_...
  /github_pat_[A-Za-z0-9_]{50,}/g,
  // GitHub classic personal access tokens: ghp_...
  /ghp_[A-Za-z0-9]{36,}/g,
  // `export VAR=value` shell assignments (value may be quoted or bare).
  /\bexport\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g,
];

/**
 * Replace real-shaped secrets in a string with a placeholder. Normal prose is
 * returned unchanged.
 */
export function redactSecrets(s: string): string {
  let out = s;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Cap a string to `maxBytes` (UTF-8). Mirrors the truncation pattern used by
 * sandbox-logs (keep the tail), but operates on byte length so multi-byte
 * characters cannot blow past the limit. Returns null for null/undefined.
 */
export function cap(s: string | null | undefined, maxBytes: number): string | null {
  if (s == null) return null;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Slice from the tail; decode tolerantly so a split multi-byte sequence at
  // the cut boundary does not throw.
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}
