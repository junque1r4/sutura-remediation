-- Sutura: data minimization for token_usage.
--
-- Historically token_usage.prompt and token_usage.response stored the full raw
-- LLM prompt and response text (NOT NULL). That text frequently contained
-- source code, diffs and -- worst of all -- plaintext secrets. Readers only
-- ever consume aggregates (token counts / cost), so the raw text is pure risk.
--
-- Choice: we do NOT drop the columns (dropping is irreversible and some code
-- paths still reference them as a short redacted excerpt). Instead we make them
-- nullable and clear all existing data. New writes persist only a short,
-- secret-scrubbed excerpt (see createTokenUsage). This is the least-bloat,
-- reversible option that still removes the sensitive payload at rest.
--
-- Idempotent: guarded with IF EXISTS so re-running is a no-op on the schema,
-- and the UPDATE is naturally idempotent.

ALTER TABLE IF EXISTS token_usage ALTER COLUMN prompt DROP NOT NULL;
ALTER TABLE IF EXISTS token_usage ALTER COLUMN response DROP NOT NULL;

-- Purge any raw prompt/response text already persisted by older writers.
UPDATE token_usage SET prompt = NULL, response = NULL
 WHERE prompt IS NOT NULL OR response IS NOT NULL;
