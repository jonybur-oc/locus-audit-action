import { Story, StoryAuditResult, AuditReport } from './types';
import { PrDiff } from './get-diff';
/**
 * Calls Claude to audit divergence and coverage for all stories against the PR diff.
 */
export declare function auditStoriesWithClaude(stories: Story[], diff: PrDiff, apiKey: string, model: string): Promise<StoryAuditResult[]>;
/**
 * Builds the AuditReport from raw story results and action config.
 */
export declare function buildReport(results: StoryAuditResult[], minCoverage: number, failOnMissing: boolean, failOnDivergence: boolean): AuditReport;
