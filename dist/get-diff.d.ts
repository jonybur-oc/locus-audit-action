export interface PrDiff {
    pr_number: number;
    base_sha: string;
    head_sha: string;
    files: PrFileDiff[];
    full_diff: string;
}
export interface PrFileDiff {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}
/**
 * Fetches the PR diff from GitHub API.
 * Returns structured file-level diffs and a concatenated full diff for LLM analysis.
 */
export declare function getPrDiff(githubToken: string): Promise<PrDiff>;
