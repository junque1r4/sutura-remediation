import { describe, it, expect } from "vitest";
import { chunkFileContent } from "../chunker";

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("chunkFileContent", () => {
  it("returns empty array for empty content", () => {
    expect(chunkFileContent("", "src/foo.ts", "myrepo", "main")).toEqual([]);
    expect(chunkFileContent("   ", "src/foo.ts", "myrepo", "main")).toEqual([]);
  });

  it("returns a single chunk for small files (<=100 lines)", () => {
    const content = makeLines(50);
    const chunks = chunkFileContent(content, "src/foo.ts", "myrepo", "main");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(50);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].filePath).toBe("src/foo.ts");
    expect(chunks[0].repo).toBe("myrepo");
    expect(chunks[0].branch).toBe("main");
    expect(chunks[0].language).toBe("typescript");
  });

  it("returns a single chunk for exactly 100-line file", () => {
    const content = makeLines(100);
    const chunks = chunkFileContent(content, "src/foo.ts", "myrepo", "main");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(100);
  });

  it("splits large files into 100-line chunks with 10-line overlap", () => {
    const content = makeLines(200);
    const chunks = chunkFileContent(content, "src/foo.ts", "myrepo", "main");

    // chunk 1: lines 1-100, chunk 2: lines 91-190, chunk 3: lines 181-200
    expect(chunks.length).toBeGreaterThan(1);

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(100);

    // Second chunk starts at line 91 (100 - 10 overlap)
    expect(chunks[1].startLine).toBe(91);
    expect(chunks[1].endLine).toBe(190);

    // Third chunk starts at line 181
    expect(chunks[2].startLine).toBe(181);
    expect(chunks[2].endLine).toBe(200);
  });

  it("overlap: the last OVERLAP lines of chunk N equal the first OVERLAP lines of chunk N+1", () => {
    const content = makeLines(150);
    const chunks = chunkFileContent(content, "src/foo.ts", "myrepo", "main");

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const chunk0Lines = chunks[0].content.split("\n");
    const chunk1Lines = chunks[1].content.split("\n");

    const tailOf0 = chunk0Lines.slice(-10);
    const headOf1 = chunk1Lines.slice(0, 10);

    expect(tailOf0).toEqual(headOf1);
  });

  it("all chunks carry filePath, repo, and branch", () => {
    const content = makeLines(250);
    const chunks = chunkFileContent(
      content,
      "src/bar.py",
      "other-repo",
      "dev"
    );

    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/bar.py");
      expect(chunk.repo).toBe("other-repo");
      expect(chunk.branch).toBe("dev");
    }
  });

  describe("language detection", () => {
    const cases: [string, string][] = [
      ["foo.ts", "typescript"],
      ["foo.tsx", "typescript"],
      ["foo.js", "javascript"],
      ["foo.jsx", "javascript"],
      ["foo.py", "python"],
      ["foo.go", "go"],
      ["foo.java", "java"],
      ["foo.rs", "rust"],
      ["foo.rb", "ruby"],
      ["foo.cs", "csharp"],
      ["foo.cpp", "cpp"],
      ["foo.swift", "swift"],
      ["foo.kt", "kotlin"],
      ["foo.sh", "shell"],
      ["foo.yaml", "yaml"],
      ["foo.yml", "yaml"],
      ["foo.json", "json"],
      ["foo.md", "markdown"],
      ["foo.sql", "sql"],
      ["foo.graphql", "graphql"],
      ["foo.tf", "terraform"],
      ["foo.xyz", "unknown"],
    ];

    for (const [filePath, expectedLanguage] of cases) {
      it(`detects ${expectedLanguage} for .${filePath.split(".").pop()} extension`, () => {
        const content = makeLines(5);
        const chunks = chunkFileContent(content, filePath, "repo", "main");
        expect(chunks[0].language).toBe(expectedLanguage);
      });
    }
  });
});
