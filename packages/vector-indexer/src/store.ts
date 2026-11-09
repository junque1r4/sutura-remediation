import { Pinecone } from "@pinecone-database/pinecone";
import type { CodeChunk } from "./chunker";

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean>;
}

const INDEX_NAME = "sutura-codebase";
const UPSERT_BATCH_SIZE = 100;
const METADATA_CONTENT_LIMIT = 10000;

function getPineconeClient(apiKey: string): Pinecone {
  return new Pinecone({ apiKey });
}

function makeVectorId(chunk: CodeChunk): string {
  return `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
}

export async function upsertChunks(
  namespace: string,
  chunks: CodeChunk[],
  embeddings: number[][],
  apiKey: string
): Promise<void> {
  if (chunks.length === 0) return;
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `Mismatch: ${chunks.length} chunks but ${embeddings.length} embeddings`
    );
  }

  const pinecone = getPineconeClient(apiKey);
  const index = pinecone.index(INDEX_NAME).namespace(namespace);

  const vectors = chunks.map((chunk, i) => ({
    id: makeVectorId(chunk),
    values: embeddings[i],
    metadata: {
      content: chunk.content.slice(0, METADATA_CONTENT_LIMIT),
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      repo: chunk.repo,
      branch: chunk.branch,
    },
  }));

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
    await index.upsert(batch);
  }
}

export async function queryVectors(
  namespace: string,
  queryVector: number[],
  topK: number,
  apiKey: string
): Promise<VectorMatch[]> {
  const pinecone = getPineconeClient(apiKey);
  const index = pinecone.index(INDEX_NAME).namespace(namespace);

  const result = await index.query({
    vector: queryVector,
    topK,
    includeMetadata: true,
  });

  return (result.matches ?? []).map((match) => ({
    id: match.id,
    score: match.score ?? 0,
    metadata: (match.metadata ?? {}) as Record<
      string,
      string | number | boolean
    >,
  }));
}

export async function deleteNamespace(
  namespace: string,
  apiKey: string
): Promise<void> {
  const pinecone = getPineconeClient(apiKey);
  const index = pinecone.index(INDEX_NAME).namespace(namespace);
  await index.deleteAll();
}
