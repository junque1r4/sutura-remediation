import type { Severity } from './finding';

export type UserRole = 'admin' | 'developer' | 'viewer';

export interface GitHubIntegration {
  installationId: number;
  account: string;
  avatarUrl: string;
  connectedAt: string;
  // 'Organization' or 'User'. Optional for backward compatibility with records
  // saved before this field was tracked; consumers should default to
  // 'Organization' when missing, since that's the common case.
  targetType?: 'Organization' | 'User';
}

export interface OrganizationIntegrations {
  github?: GitHubIntegration | null;
}

export interface OrganizationSettings {
  autoFixSeverityThreshold: Severity;
  autoMerge: boolean;
  branchStrategy: {
    targetBranch: string;
    namingConvention: string;
  };
  notificationChannels: NotificationChannel[];
  reviewAssignment: {
    team?: string;
    users?: string[];
  };
  integrations?: OrganizationIntegrations;
  /**
   * Pre-fix verification (exploitability) gate. When undefined or true the
   * validated-fix orchestrator runs a verification agent before generating a
   * fix and skips findings it judges not real / unreachable. Set to false to
   * disable the gate org-wide (legacy behaviour).
   */
  verifyBeforeFix?: boolean;
  /**
   * Adversarial patch validation (independent grader + bypass agent). When
   * undefined or true the validated-fix orchestrator, after a rescan reports
   * 'resolved', independently re-verifies the fix from a fresh workspace and
   * red-teams it before opening a PR. Set to false to disable org-wide (accept
   * a fix as soon as the rescan passes -- legacy behaviour).
   */
  adversarialValidation?: boolean;
  /**
   * Per-repo dependency-cache prewarm. Default OFF (opt-in): when true, the
   * validated-fix orchestrator warms a per-repo cache once and mounts it
   * read-only on each attempt so the attempt's restore runs offline. Only
   * applied to code fixes with a developer-taught toolchain; the global
   * SUTURA_PREWARM_DISABLED kill-switch overrides it.
   */
  prewarmCache?: boolean;
}

export interface NotificationChannel {
  type: 'slack' | 'email' | 'webhook';
  target: string;
  events: string[];
}

export interface CustomPrompts {
  environmentSetup?: string;
  testingInstructions?: string;
  codeConventions?: string;
  dependencyRules?: string;
  businessContext?: string;
}

export interface Organization {
  id: string;
  name: string;
  plan: string;
  settings: OrganizationSettings;
  customPrompts: CustomPrompts;
  createdAt: Date;
}
