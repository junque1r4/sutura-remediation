// Prices in USD per 1M tokens (Anthropic list prices; adjust as needed).
// If a model is not listed, falls back to the unknown-model rate.
interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
  'claude-opus-4-6': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5 },
};

const FALLBACK: ModelPrice = { inputPer1M: 3, outputPer1M: 15 };

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[model] ?? FALLBACK;
  const cost = (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
