export interface CodeChunk {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  repo: string;
  branch: string;
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  java: "java",
  rs: "rust",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  tf: "terraform",
  toml: "toml",
  xml: "xml",
};

const CHUNK_SIZE = 100;
const OVERLAP = 10;

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "unknown";
}

export function chunkFileContent(
  content: string,
  filePath: string,
  repo: string,
  branch: string
): CodeChunk[] {
  if (!content || content.trim() === "") {
    return [];
  }

  const lines = content.split("\n");
  const language = detectLanguage(filePath);

  if (lines.length <= CHUNK_SIZE) {
    return [
      {
        content,
        filePath,
        startLine: 1,
        endLine: lines.length,
        language,
        repo,
        branch,
      },
    ];
  }

  const chunks: CodeChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    const chunkLines = lines.slice(start, end);

    chunks.push({
      content: chunkLines.join("\n"),
      filePath,
      startLine: start + 1,
      endLine: end,
      language,
      repo,
      branch,
    });

    if (end === lines.length) {
      break;
    }

    start = end - OVERLAP;
  }

  return chunks;
}
