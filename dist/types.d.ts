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
export interface StoryAuditResult {
    story: Story;
    covered: boolean;
    confidence: 'high' | 'medium' | 'low';
    evidence: string;
    files_touched: string[];
}
export interface AuditReport {
    total: number;
    covered: number;
    uncovered: number;
    coverage_percent: number;
    results: StoryAuditResult[];
    passed: boolean;
    min_coverage: number;
    fail_on_missing: boolean;
}
export interface ActionInputs {
    storiesPath: string;
    minCoverage: number;
    failOnMissing: boolean;
    anthropicApiKey: string;
    githubToken: string;
    model: string;
    statusOnly: boolean;
}
