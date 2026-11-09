import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CLAUDE_MODEL } from '@sutura/common';
import { extractDiff, generateFix } from '../pipeline/generator';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        messages: {
          create: mockCreate,
        },
      };
    }),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function makeResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe('extractDiff', () => {
  it('extracts diff from ```diff code block', () => {
    const text =
      'Here is the fix:\n```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n```\nDone.';
    const result = extractDiff(text);
    expect(result).toBe('--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new');
  });

  it('falls back to unified diff markers when no diff block', () => {
    const text = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new';
    const result = extractDiff(text);
    expect(result).not.toBeNull();
    expect(result).toContain('--- a/foo.ts');
  });

  it('returns null when no diff is found', () => {
    const result = extractDiff('No diff here, just some text explanation.');
    expect(result).toBeNull();
  });

  it('handles multiple hunks in a diff block', () => {
    const diff =
      '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n context\n-old1\n+new1\n@@ -10,3 +10,3 @@\n ctx\n-old2\n+new2';
    const text = `\`\`\`diff\n${diff}\n\`\`\``;
    const result = extractDiff(text);
    expect(result).toContain('@@ -1,3 +1,3 @@');
    expect(result).toContain('@@ -10,3 +10,3 @@');
  });
});

describe('generateFix', () => {
  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  it('returns diff when response contains a valid diff block', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(
      makeResponse(
        'Here is the fix:\n```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n```',
      ),
    );

    const result = await generateFix('test prompt', 'fake-api-key');
    expect(result.diff).toBe('--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new');
    expect(result.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(result.tokensUsed).toBe(150);
    expect(result.promptSnapshot).toBe('test prompt');
  });

  it('retries when first response has no valid diff', async () => {
    const mockCreate = await getMockCreate();
    mockCreate
      .mockResolvedValueOnce(makeResponse('I will fix this vulnerability. Let me think...'))
      .mockResolvedValueOnce(
        makeResponse('```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n```'),
      );

    const result = await generateFix('test prompt', 'fake-api-key');
    expect(result.diff).toBe('--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns empty diff after exhausting retries on malformed response', async () => {
    const mockCreate = await getMockCreate();
    // MAX_RETRIES = 2, so 3 total attempts
    mockCreate.mockResolvedValue(makeResponse('Here is my analysis but no diff...'));

    const result = await generateFix('test prompt', 'fake-api-key');
    expect(result.diff).toBe('');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('includes retry message in subsequent calls', async () => {
    const mockCreate = await getMockCreate();
    mockCreate
      .mockResolvedValueOnce(makeResponse('No diff here'))
      .mockResolvedValueOnce(
        makeResponse('```diff\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-x\n+y\n```'),
      );

    await generateFix('test prompt', 'fake-api-key');

    const secondCall = mockCreate.mock.calls[1][0];
    const messages = secondCall.messages;
    expect(messages.length).toBeGreaterThan(1);
    const retryMessage = messages.find(
      (m: { role: string; content: string }) =>
        m.role === 'user' && m.content.includes('did not contain a valid unified diff'),
    );
    expect(retryMessage).toBeDefined();
  });
});
