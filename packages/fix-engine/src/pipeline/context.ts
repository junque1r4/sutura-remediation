import type { NormalizedFinding, CustomPrompts } from '@sutura/common';
import { queryRelevantContext } from '@sutura/vector-indexer';
import { Octokit } from '@octokit/rest';

export interface FixContext {
  finding: NormalizedFinding;
  orgId: string;
  customPrompts: CustomPrompts;
  relevantCode: string[];
  vulnerableFileContent: string | null;
}

export async function retrieveContext(
  finding: NormalizedFinding,
  orgId: string,
  customPrompts: CustomPrompts,
  config: {
    voyageApiKey: string;
    pineconeApiKey: string;
    githubToken: string;
  },
): Promise<FixContext> {
  // 1. Query RAG context (non-fatal on failure)
  let relevantCode: string[] = [];
  try {
    relevantCode = await queryRelevantContext(finding, orgId, finding.repo, {
      voyageApiKey: config.voyageApiKey,
      pineconeApiKey: config.pineconeApiKey,
    });
  } catch {
    // non-fatal: proceed without RAG context
  }

  // 2. Fetch vulnerable file from GitHub if filePath exists (non-fatal on failure)
  let vulnerableFileContent: string | null = null;
  if (finding.filePath) {
    try {
      const octokit = new Octokit({ auth: config.githubToken });
      // repo is expected as "owner/repo"
      const [owner, repo] = finding.repo.split('/');
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: finding.filePath,
      });
      const data = response.data;
      if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
        vulnerableFileContent = Buffer.from(data.content, 'base64').toString('utf-8');
      }
    } catch {
      // non-fatal: proceed without file content
    }
  }

  return {
    finding,
    orgId,
    customPrompts,
    relevantCode,
    vulnerableFileContent,
  };
}
