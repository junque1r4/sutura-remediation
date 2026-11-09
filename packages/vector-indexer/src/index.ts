// @sutura/vector-indexer entrypoint
export type { CodeChunk } from "./chunker";
export { chunkFileContent } from "./chunker";
export { embedTexts, embedQuery } from "./embedder";
export type { VectorMatch } from "./store";
export { upsertChunks, queryVectors, deleteNamespace } from "./store";
export { queryRelevantContext } from "./query";
export type { IndexResult } from "./indexer";
export { indexRepository } from "./indexer";
