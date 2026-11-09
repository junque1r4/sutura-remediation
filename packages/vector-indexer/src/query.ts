import type { NormalizedFinding } from '@sutura/common';
import { embedQuery } from './embedder';
import { queryVectors } from './store';

interface QueryConfig {
  voyageApiKey: string;
  pineconeApiKey: string;
}

function buildQueryText(finding: NormalizedFinding): string {
  const parts: string[] = [];

  parts.push(finding.title);

  if (finding.description) {
    parts.push(finding.description);
  }

  if (finding.filePath) {
    parts.push(`File: ${finding.filePath}`);
  }

  if (finding.cweId) {
    parts.push(`CWE: ${finding.cweId}`);
  }

  return parts.join('\n');
}

export async function queryRelevantContext(
  finding: NormalizedFinding,
  orgId: string,
  repo: string,
  config: QueryConfig,
  topK = 5,
): Promise<string[]> {
  const queryText = buildQueryText(finding);
  const namespace = `${orgId}/${repo}/main`;

  const vector = await embedQuery(queryText, config.voyageApiKey);
  const matches = await queryVectors(namespace, vector, topK, config.pineconeApiKey);

  return matches.map((match) => {
    const filePath = match.metadata.filePath as string;
    const content = match.metadata.content as string;
    return `// File: ${filePath}\n${content}`;
  });
}
