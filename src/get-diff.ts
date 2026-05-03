import * as github from '@actions/github';
import * as core from '@actions/core';

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
export async function getPrDiff(githubToken: string): Promise<PrDiff> {
  const context = github.context;

  if (!context.payload.pull_request) {
    throw new Error('This action must run on pull_request events');
  }

  const octokit = github.getOctokit(githubToken);
  const pr = context.payload.pull_request;
  const prNumber = pr.number;

  core.debug(`Fetching diff for PR #${prNumber}`);

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const prFiles: PrFileDiff[] = files.map(f => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  // Build a single diff text for the LLM — include filename headers + patches
  // Truncate large diffs to stay within Claude's context
  const MAX_DIFF_CHARS = 80_000;
  let fullDiff = '';

  for (const f of prFiles) {
    if (!f.patch) continue;
    const segment = `\n--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${f.patch}\n`;
    if (fullDiff.length + segment.length > MAX_DIFF_CHARS) {
      fullDiff += `\n[... diff truncated at ${MAX_DIFF_CHARS} chars — ${prFiles.length - prFiles.indexOf(f)} files omitted ...]\n`;
      break;
    }
    fullDiff += segment;
  }

  return {
    pr_number: prNumber,
    base_sha: pr.base.sha,
    head_sha: pr.head.sha,
    files: prFiles,
    full_diff: fullDiff,
  };
}
