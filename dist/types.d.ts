export interface Story {
    id: string;
    title: string;
    description?: string;
    status?: string;
    section?: string;
    acceptance_criteria?: string[];
    depends_on?: string[];
    design_ref?: string;
    test_refs?: string[];
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
 *   satisfied  — all ACs covered by this PR
 *   partial    — some ACs covered, none diverged
 *   not-covered — diff doesn't touch this story
 *   diverged   — diff actively contradicts at least one AC
 */
export interface StoryAuditResult {
    story: Story;
    status: 'satisfied' | 'partial' | 'not-covered' | 'diverged';
    /** Backward-compat alias: true when status === 'satisfied' or 'partial' */
    covered: boolean;
    confidence: 'high' | 'medium' | 'low';
    evidence: string;
    files_touched: string[];
    ac_results?: AcResult[];
    /** For partial: how many ACs satisfied */
    acs_satisfied?: number;
    acs_total?: number;
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
export interface ActionInputs {
    storiesPath: string;
    minCoverage: number;
    failOnMissing: boolean;
    failOnDivergence: boolean;
    anthropicApiKey: string;
    githubToken: string;
    model: string;
    statusOnly: boolean;
}
