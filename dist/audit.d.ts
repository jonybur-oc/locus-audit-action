import { Story, StoryAuditResult, AuditReport } from './types';
import { PrDiff } from './get-diff';
/**
 * Calls Claude to audit divergence and coverage for all stories against the PR diff.
 * Stories with skip-statuses (deprecated, in-progress, implemented) are excluded
 * from the Claude call and returned with status='skipped'.
 */
export declare function auditStoriesWithClaude(stories: Story[], diff: PrDiff, apiKey: string, model: string): Promise<StoryAuditResult[]>;
/**
 * Builds the AuditReport from raw story results and action config.
 * Skipped stories (deprecated / in-progress / implemented) are excluded from
 * coverage calculations per spec rules 8.1.5 and 8.1.6.
 */
export declare function buildReport(results: StoryAuditResult[], minCoverage: number, failOnMissing: boolean, failOnDivergence: boolean): AuditReport;
