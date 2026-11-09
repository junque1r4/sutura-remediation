import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embedTexts, embedQuery } from "../embedder";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeVoyageResponse(count: number): Response {
  const data = Array.from({ length: count }, (_, i) => ({
    embedding: [i * 0.1, i * 0.2, i * 0.3],
  }));
  return {
    ok: true,
    json: async () => ({ data }),
    text: async () => "",
  } as unknown as Response;
}

const API_KEY = "test-api-key";

beforeEach(() => {
  mockFetch.mockReset();
});

describe("embedTexts", () => {
  it("returns empty array for empty input without calling fetch", async () => {
    const result = await embedTexts([], API_KEY);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("single batch (< 128 texts) makes one fetch call with input_type 'document'", async () => {
    const texts = ["hello", "world", "foo"];
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(texts.length));

    const result = await embedTexts(texts, API_KEY);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");

    const body = JSON.parse(options.body);
    expect(body.input_type).toBe("document");
    expect(body.input).toEqual(texts);
    expect(result).toHaveLength(texts.length);
  });

  it("uses the correct model (voyage-code-3)", async () => {
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(1));

    await embedTexts(["test"], API_KEY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("voyage-code-3");
  });

  it("sends Authorization header as Bearer {apiKey}", async () => {
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(1));

    await embedTexts(["test"], API_KEY);

    const { headers } = mockFetch.mock.calls[0][1];
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("multiple batches (> 128 texts) makes multiple fetch calls", async () => {
    // 130 texts → 2 batches: 128 + 2
    const texts = Array.from({ length: 130 }, (_, i) => `text ${i}`);

    mockFetch
      .mockResolvedValueOnce(makeVoyageResponse(128))
      .mockResolvedValueOnce(makeVoyageResponse(2));

    const result = await embedTexts(texts, API_KEY);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(130);

    // First batch has 128 items, second batch has 2
    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body1.input).toHaveLength(128);
    expect(body2.input).toHaveLength(2);
  });

  it("returns embeddings in correct order across batches", async () => {
    const texts = Array.from({ length: 256 }, (_, i) => `text ${i}`);

    // Build recognizable embeddings: first batch embeddings start with index, second batch continue
    const batch1Data = Array.from({ length: 128 }, (_, i) => ({
      embedding: [i, 0, 0],
    }));
    const batch2Data = Array.from({ length: 128 }, (_, i) => ({
      embedding: [i + 128, 0, 0],
    }));

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: batch1Data }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: batch2Data }),
      } as unknown as Response);

    const result = await embedTexts(texts, API_KEY);

    expect(result).toHaveLength(256);
    expect(result[0]).toEqual([0, 0, 0]);
    expect(result[127]).toEqual([127, 0, 0]);
    expect(result[128]).toEqual([128, 0, 0]);
    expect(result[255]).toEqual([255, 0, 0]);
  });

  it("throws with status code on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as unknown as Response);

    await expect(embedTexts(["test"], API_KEY)).rejects.toThrow(
      "Voyage AI API error 401"
    );
  });

  it("throws with error body on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    } as unknown as Response);

    await expect(embedTexts(["test"], API_KEY)).rejects.toThrow(
      "Rate limit exceeded"
    );
  });
});

describe("embedQuery", () => {
  it("makes one fetch call with input_type 'query'", async () => {
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(1));

    await embedQuery("find authentication logic", API_KEY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input_type).toBe("query");
  });

  it("sends the query text as a single-element array", async () => {
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(1));

    await embedQuery("search query", API_KEY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(["search query"]);
  });

  it("returns a single embedding vector (not array of arrays)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
      }),
    } as unknown as Response);

    const result = await embedQuery("test", API_KEY);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([0.1, 0.2, 0.3, 0.4]);
    // Should be a flat array, not array of arrays
    expect(typeof result[0]).toBe("number");
  });

  it("throws with status code on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as unknown as Response);

    await expect(embedQuery("test", API_KEY)).rejects.toThrow(
      "Voyage AI API error 500"
    );
  });

  it("uses Bearer auth header", async () => {
    const key = "my-query-api-key";
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(1));

    await embedQuery("test", key);

    const { headers } = mockFetch.mock.calls[0][1];
    expect(headers["Authorization"]).toBe(`Bearer ${key}`);
  });
});
