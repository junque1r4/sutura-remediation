// @sutura/fix-engine entrypoint
export { FixPipeline } from './pipeline';
export type { PipelineConfig, PipelineResult } from './pipeline';

export { triage } from './pipeline/triage';
export type { TriageResult } from './pipeline/triage';

export { assemblePrompt } from './pipeline/prompt';

export { generateFix, extractDiff } from './pipeline/generator';
export type { GenerateResult } from './pipeline/generator';

export { submitFix, submitMultiFile } from './pipeline/submitter';
export type {
  SubmitResult,
  SubmitMultiFileInput,
  FileChange,
} from './pipeline/submitter';

export { ValidatedFixPipeline, ensureWarmCache } from './pipeline/validated';
export type {
  ValidatedFixConfig,
  ValidatedFixResult,
  ValidatedFixSuccess,
  ValidatedFixFailure,
  ValidatedFixDeps,
  ValidatedFixPersistence,
  AttemptFailure,
  GraderVerdict,
  BypassResult,
  PrewarmDeps,
  PrewarmResult,
} from './pipeline/validated';
