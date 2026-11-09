export type TestResult = 'pass' | 'fail' | 'skip';
export type PrStatus = 'open' | 'merged' | 'closed' | 'edited';
// 'skipped' is a neutral terminal state: the pipeline deliberately declined to
// fix the finding (verification gate judged it not exploitable/unreachable, or
// triage put it below the auto-fix threshold). It is NOT a failure and must not
// render as a red attempt -- see the dashboard stage/tone helpers.
export type FixAttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'exhausted'
  | 'skipped';
export type ValidationStatus = 'resolved' | 'still_vulnerable' | 'inconclusive';

export interface FixAttemptTestFile {
  path: string;
  content: string;
}

export interface FixAttempt {
  id: string;
  findingId: string;
  orgId: string;
  promptSnapshot: string;
  generatedDiff: string;
  testResult: TestResult;
  prUrl?: string;
  prStatus?: PrStatus;
  claudeModel: string;
  claudeTokensUsed: number;
  createdAt: Date;
  completedAt?: Date;
  attemptNumber?: number;
  parentAttemptId?: string;
  status?: FixAttemptStatus;
  testOutput?: string;
  testFilesAdded?: FixAttemptTestFile[];
  validationStatus?: ValidationStatus;
  scanOutput?: string;
  scanTool?: string;
  failureReason?: string;
}
