export interface Story {
  /**
   * story_id is the canonical human-readable identifier per the Locus spec v1.x.
   * The id field (UUID v4) is the stable cross-tool reference.
   * parse-stories.ts normalises both: story_id takes precedence; id is kept for UUID usage.
   */
  story_id: string;   // canonical — human-readable e.g. BT-01, US-03
  id?: string;        // optional UUID v4 — stable cross-system reference
  title: string;
  description?: string;
  status?: string;
  section?: string;
  acceptance_criteria?: string[];
  depends_on?: string[];
  design_ref?: string;
  test_refs?: string[];
  /**
   * file_refs: optional list of file paths (relative to repo root) that implement this story.
   * Supports glob patterns (e.g. src/deposit/**\/*.ts).
   * When present: the CI audit action only audits this story if at least one listed file
   * appears in the PR diff. Stories with no file_refs fall back to Claude inference.
   * Added in spec v1.3 (VON-107).
   */
  file_refs?: string[];
  // legacy / extended fields
  as_a?: string;
  i_want?: string;
  so_that?: string;
}

export interface StoriesFile {
  version?: string;
  project?: string;
  stories: Story[];
}

/**
 * Per-acceptance-criteria result from divergence audit.
 */
export interface AcResult {
  criterion: string;
  status: 'satisfied' | 'partial' | 'not-covered' | 'diverged';
  evidence: string;
}

/**
 * Per-story result from divergence audit.
 * status:
 *   satisfied    — all ACs covered by this PR
 *   partial      — some ACs covered, none diverged
 *   not-covered  — diff doesn't touch this story
 *   diverged     — diff actively contradicts at least one AC
 *   skipped      — excluded from audit (deprecated / in-progress / implemented)
 *   not-affected — story has file_refs and none matched the PR diff (deterministic skip)
 */
export interface StoryAuditResult {
  story: Story;
  status: 'satisfied' | 'partial' | 'not-covered' | 'diverged' | 'skipped' | 'not-affected';
  /** Backward-compat alias: true when status === 'satisfied' or 'partial' */
  covered: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  files_touched: string[];
  ac_results?: AcResult[];
  /** For partial: how many ACs satisfied */
  acs_satisfied?: number;
  acs_total?: number;
  /**
   * Result of deterministic test_refs check (VON-101).
   * Present only when the story has test_refs.
   * When verdict is 'pass' or 'fail', this overrides or supplements Claude's result.
   */
  test_refs_result?: import('./test-refs-audit').TestRefsResult;
}

export interface AuditReport {
  total: number;
  covered: number;
  uncovered: number;
  diverged: number;
  coverage_percent: number;
  results: StoryAuditResult[];
  passed: boolean;
  min_coverage: number;
  fail_on_missing: boolean;
  fail_on_divergence: boolean;
}

/**
 * Re-export for convenience — full type lives in test-refs-audit.ts
 * Imported here so StoryAuditResult can reference it without circular deps.
 */
export type { TestRefsResult, TestRefsVerdict, TestRefFileResult } from './test-refs-audit';

export interface ActionInputs {
  storiesPath: string;
  minCoverage: number;
  failOnMissing: boolean;
  failOnDivergence: boolean;
  anthropicApiKey: string;
  githubToken: string;
  model: string;
  statusOnly: boolean;
  /** Optional path to jest/cypress JSON test output for deterministic test_refs check */
  testOutputPath?: string;
}
