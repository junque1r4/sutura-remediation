const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-code-3";
const BATCH_SIZE = 128;

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

async function callVoyageAPI(
  input: string[],
  input_type: "document" | "query",
  apiKey: string
): Promise<number[][]> {
  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input,
      input_type,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Voyage AI API error ${response.status}: ${body}`
    );
  }

  const json = (await response.json()) as VoyageResponse;
  return json.data.map((item) => item.embedding);
}

export async function embedTexts(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await callVoyageAPI(batch, "document", apiKey);
    results.push(...embeddings);
  }

  return results;
}

export async function embedQuery(
  text: string,
  apiKey: string
): Promise<number[]> {
  const embeddings = await callVoyageAPI([text], "query", apiKey);
  return embeddings[0];
}
