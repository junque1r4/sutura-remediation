import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redactSecrets, cap } from '../data-minimization';

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------
describe('redactSecrets', () => {
  it('masks a real-shaped Anthropic API key', () => {
    const key = 'sk-ant-' + 'a1B2c3'.repeat(10); // 60-char tail
    const out = redactSecrets(`token is ${key} end`);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  it('masks a GitHub classic personal access token', () => {
    const token = 'ghp_' + 'A1b2C3d4E5'.repeat(4); // 40-char tail
    const out = redactSecrets(`auth=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  it('masks a GitHub fine-grained PAT', () => {
    const token = 'github_pat_' + 'X'.repeat(60);
    const out = redactSecrets(token);
    expect(out).toBe('[REDACTED]');
  });

  it('masks export VAR=value shell assignments', () => {
    expect(redactSecrets('run export API_KEY=supersecret123 now')).toContain('[REDACTED]');
    expect(redactSecrets('run export API_KEY=supersecret123 now')).not.toContain('supersecret123');
    expect(redactSecrets('export TOKEN="quoted value"')).not.toContain('quoted value');
  });

  it('masks multiple secrets in one string', () => {
    const a = 'sk-ant-' + 'z'.repeat(55);
    const b = 'ghp_' + '0'.repeat(40);
    const out = redactSecrets(`${a} and ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('leaves normal prose untouched', () => {
    const prose =
      'The export pipeline failed because the ghp token format looks like a prefix only.';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not over-match short strings that merely share a prefix', () => {
    // Too short to be a real key -> must not be redacted.
    const text = 'sk-ant-short and ghp_tiny';
    expect(redactSecrets(text)).toBe(text);
  });

  it('returns the empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// cap
// ---------------------------------------------------------------------------
describe('cap', () => {
  it('returns null for null/undefined', () => {
    expect(cap(null, 10)).toBeNull();
    expect(cap(undefined, 10)).toBeNull();
  });

  it('returns the string unchanged when within the byte limit', () => {
    expect(cap('hello', 10)).toBe('hello');
  });

  it('truncates to the byte limit, keeping the tail', () => {
    const out = cap('abcdefghij', 4);
    expect(out).toBe('ghij');
    expect(Buffer.byteLength(out as string, 'utf8')).toBe(4);
  });

  it('caps by bytes, not characters (multi-byte safe)', () => {
    // Each emoji is 4 bytes in UTF-8.
    const out = cap('a'.repeat(100), 8);
    expect(Buffer.byteLength(out as string, 'utf8')).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// createTokenUsage SQL params -- must NOT include full prompt/response
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
vi.mock('../../db/client', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { createTokenUsage } from '../../db/token-usage';

describe('createTokenUsage data minimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ id: 'tu-1' }] });
  });

  it('does not persist the full prompt/response, and redacts secrets', async () => {
    const secret = 'sk-ant-' + 'q'.repeat(60);
    const hugePrompt = secret + ' ' + 'x'.repeat(50_000);
    const hugeResponse = 'y'.repeat(50_000);

    await createTokenUsage({
      operation: 'analysis',
      model: 'claude-3-5-sonnet',
      input_tokens: 100,
      output_tokens: 50,
      prompt: hugePrompt,
      response: hugeResponse,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const storedPrompt = params[10] as string;
    const storedResponse = params[11] as string;

    // Full payload must not be persisted.
    expect(storedPrompt.length).toBeLessThan(hugePrompt.length);
    expect(storedResponse.length).toBeLessThan(hugeResponse.length);
    // Capped to the configured excerpt byte limit.
    expect(Buffer.byteLength(storedPrompt, 'utf8')).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(storedResponse, 'utf8')).toBeLessThanOrEqual(1024);
    // Secret-shaped text must never reach the database.
    expect(storedPrompt).not.toContain(secret);
  });

  it('still persists token counts and cost', async () => {
    await createTokenUsage({
      operation: 'analysis',
      model: 'claude-3-5-sonnet',
      input_tokens: 100,
      output_tokens: 50,
      prompt: 'p',
      response: 'r',
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe(100); // input_tokens
    expect(params[4]).toBe(50); // output_tokens
    expect(typeof params[5]).toBe('number'); // cost_usd
  });
});
