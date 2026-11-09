import type { Severity } from './finding';

/**
 * Verdict produced by the pre-fix verification (exploitability) agent. The
 * agent reads the vulnerable code in the sandbox workspace and decides whether
 * the finding is a real, reachable vulnerability worth spending a fix attempt
 * on. The orchestrator gates fix generation on this verdict; the backend
 * persists it on the `findings` row so the dashboard can surface it.
 */
export interface VerificationVerdict {
  /** Whether the agent believes the reported vulnerability is genuine (not a false positive). */
  isReal: boolean;
  /** Whether the vulnerable code path is reachable from an entry point / attacker-controlled input. */
  reachable: boolean;
  /** Re-assessed exploitability severity (may differ from the scanner's reported severity). */
  exploitability: Severity;
  /** Agent's confidence in this verdict. */
  confidence: 'high' | 'medium' | 'low';
  /** Short human-readable justification for the verdict. */
  reasoning: string;
  /** ISO timestamp when the verdict was produced. */
  verifiedAt: string;
}
