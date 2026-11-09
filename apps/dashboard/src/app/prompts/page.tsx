'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { RepoPromptsSection } from './repo-prompts-section';

interface PromptCategory {
  id: string;
  label: string;
  placeholder: string;
  lastUpdated: string;
}

const PROMPT_CATEGORIES: PromptCategory[] = [
  {
    id: 'environment',
    label: 'Environment Setup',
    placeholder:
      'e.g. This project uses Node.js 20 with pnpm. Run `pnpm install` before executing tests. The test suite uses Vitest and can be run with `pnpm test`.',
    lastUpdated: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'testing',
    label: 'Testing Instructions',
    placeholder:
      'e.g. Always run the full test suite after applying a fix. Integration tests require a running Postgres instance on port 5432. Mock external API calls using MSW.',
    lastUpdated: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'conventions',
    label: 'Code Conventions',
    placeholder:
      "e.g. Use TypeScript strict mode. Prefer functional components. Don't use default exports. Follow the Airbnb style guide. All new functions must have JSDoc comments.",
    lastUpdated: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'dependencies',
    label: 'Dependency Rules',
    placeholder:
      'e.g. Do not introduce new dependencies without approval. Prefer built-in Node.js APIs over third-party packages where possible. Never use deprecated packages.',
    lastUpdated: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'business',
    label: 'Business Context',
    placeholder:
      'e.g. This is a fintech product handling PII and PCI data. All database queries must be parameterized. GDPR compliance is mandatory for EU user data.',
    lastUpdated: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

function formatLastUpdated(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return `${diffDays} days ago`;
}

export default function PromptsPage() {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(PROMPT_CATEGORIES.map((c) => [c.id, ''])),
  );
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  function handleSave(id: string) {
    setSaved((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => setSaved((prev) => ({ ...prev, [id]: false })), 2000);
  }

  return (
    <>
      <PageHeader
        title="Custom Prompts"
        subtitle="Guide the AI with project-specific context for higher quality fixes"
      />

      {/* Info banner */}
      <div className="mb-6 rounded-lg border border-orange/30 bg-orange/5 p-4">
        <p className="text-sm text-navy">
          <span className="font-semibold text-orange">How it works:</span> These prompts are
          injected into every AutoFix session. More specific context leads to better fixes and fewer
          failed test runs. Each category is optional — leave blank to use the default behavior.
        </p>
      </div>

      <RepoPromptsSection />

      <div className="space-y-5">
        {PROMPT_CATEGORIES.map((category) => {
          const value = values[category.id] ?? '';
          const charCount = value.length;
          const isSaved = saved[category.id] ?? false;

          return (
            <div key={category.id} className="rounded-lg border border-border bg-white p-5">
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-semibold text-navy">{category.label}</label>
                <span className="text-xs text-gray-muted">
                  Last updated: {formatLastUpdated(category.lastUpdated)}
                </span>
              </div>

              <textarea
                value={value}
                onChange={(e) => setValues((prev) => ({ ...prev, [category.id]: e.target.value }))}
                placeholder={category.placeholder}
                rows={4}
                className="w-full resize-y rounded border border-border px-3 py-2 text-sm text-navy placeholder:text-gray-muted focus:outline-none focus:ring-2 focus:ring-orange"
              />

              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-gray-muted">{charCount} characters</span>
                <button
                  onClick={() => handleSave(category.id)}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    isSaved
                      ? 'bg-status-success text-white'
                      : 'bg-orange text-white hover:bg-orange-deep'
                  }`}
                >
                  {isSaved ? 'Saved!' : 'Save'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
