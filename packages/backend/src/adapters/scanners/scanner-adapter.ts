import type { NormalizedFinding } from '@sutura/common';

export interface ScannerAdapter {
  name: string;
  normalizeWebhookPayload(payload: unknown): NormalizedFinding[];
  fetchFindings(config: ScannerConfig): Promise<NormalizedFinding[]>;
}

export interface ScannerConfig {
  apiKey: string;
  baseUrl?: string;
  orgId: string;
}
