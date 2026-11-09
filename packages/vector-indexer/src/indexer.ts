import { Octokit } from '@octokit/rest';
import { chunkFileContent } from './chunker';
import { embedTexts } from './embedder';
import { upsertChunks, deleteNamespace } from './store';

export interface IndexResult {
  fileCount: number;
  chunkCount: number;
  namespace: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.rb',
]);

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', '.git', 'vendor', '.next', 'build', 'coverage', '__pycache__',
]);

function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.split('/');
  return parts.some((part) => IGNORED_DIRS.has(part));
}

function hasSupportedExtension(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex);
  return SUPPORTED_EXTENSIONS.has(ext);
}

function isSupported(filePath: string): boolean {
  return hasSupportedExtension(filePath) && !isIgnoredPath(filePath);
}

export async function indexRepository(
  repo: string,
  branch: string,
  githubToken: string,
  orgId: string,
  config: { voyageApiKey: string; pineconeApiKey: string },
): Promise<IndexResult> {
  const namespace = `${orgId}/${repo}/main`;
  const [owner, repoName] = repo.split('/');

  const octokit = new Octokit({ auth: githubToken });

  // 1. Delete previous index namespace
  await deleteNamespace(namespace, config.pineconeApiKey);

  // 2. Fetch file tree via octokit.git.getTree (recursive)
  const { data: tree } = await octokit.git.getTree({
    owner,
    repo: repoName,
    tree_sha: branch,
    recursive: 'true',
  });

  // 3. Filter to supported files
  const supportedFiles = (tree.tree ?? []).filter(
    (item) => item.type === 'blob' && item.path && isSupported(item.path),
  );

  let chunkCount = 0;

  // 5-8. Process each file: fetch, chunk, embed, upsert
  for (const file of supportedFiles) {
    const filePath = file.path!;

    let fileContent: string;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: filePath,
        ref: branch,
      });

      if (Array.isArray(data) || data.type !== 'file') {
        continue;
      }

      // Decode base64 content
      fileContent = Buffer.from(data.content, 'base64').toString('utf-8');
    } catch {
      // Skip files that cannot be fetched
      continue;
    }

    // 6. Chunk each file
    const chunks = chunkFileContent(fileContent, filePath, repo, branch);
    if (chunks.length === 0) continue;

    // 7. Embed all chunks
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedTexts(texts, config.voyageApiKey);

    // 8. Upsert to Pinecone
    await upsertChunks(namespace, chunks, embeddings, config.pineconeApiKey);

    chunkCount += chunks.length;
  }

  // 9. Return counts
  return {
    fileCount: supportedFiles.length,
    chunkCount,
    namespace,
  };
}
