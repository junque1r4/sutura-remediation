/**
 * Single source of truth for the Claude model used across the remediation
 * pipeline: dashboard analysis, fix generation, pre-fix verification, test
 * generation, the adversarial bypass agent, and toolchain derivation.
 *
 * Keep this as the ONE place a model migration touches. Each stage previously
 * hardcoded its own literal, which drifted: the dated `claude-sonnet-4-20250514`
 * id was retired by the API (404 not_found) yet lingered in the fix-engine while
 * the dashboard had already moved on, silently breaking verification and fix
 * generation. Centralizing prevents that class of drift.
 *
 * Stages that accept a caller override still do (`input.model ?? DEFAULT_CLAUDE_MODEL`);
 * this is only the default. Update token-pricing.ts when this changes so cost
 * attribution stays correct.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
