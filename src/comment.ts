import * as github from '@actions/github';
import * as core from '@actions/core';
import { AuditReport, StoryAuditResult } from './types';

const COMMENT_MARKER = '<!-- locus-audit-action -->';

function badge(percent: number, passed: boolean): string {
  const color = passed ? 'brightgreen' : percent >= 50 ? 'yellow' : 'red';
  return `![Locus Coverage](https://img.shields.io/badge/story%20coverage-${percent}%25-${color}?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik05IDEyLjVsLTMuNS0zLjUtMS41IDEuNUw5IDE1LjVsMTAtMTAtMS41LTEuNXoiLz48L3N2Zz4=)`;
}

function storyRow(r: StoryAuditResult): string {
  const icon = r.covered ? '✅' : '❌';
  const conf = r.confidence === 'high' ? '' : ` _(${r.confidence})_`;
  const files = r.files_touched.length > 0
    ? `<br><sub>${r.files_touched.slice(0, 3).join(', ')}${r.files_touched.length > 3 ? ` +${r.files_touched.length - 3} more` : ''}</sub>`
    : '';
  return `| ${icon} | \`${r.story.id}\` | ${r.story.title}${conf} | ${r.evidence}${files} |`;
}

export function buildCommentBody(report: AuditReport): string {
  const { coverage_percent, covered, total, passed, min_coverage, fail_on_missing } = report;

  const statusLine = passed
    ? `✅ **Audit passed** — ${coverage_percent}% story coverage (${covered}/${total} stories)`
    : `❌ **Audit failed** — ${coverage_percent}% story coverage (${covered}/${total} stories)`;

  const failReasons: string[] = [];
  if (!passed) {
    if (coverage_percent < min_coverage) {
      failReasons.push(`coverage ${coverage_percent}% < required ${min_coverage}%`);
    }
    if (fail_on_missing && report.uncovered > 0) {
      failReasons.push(`${report.uncovered} uncovered ${report.uncovered === 1 ? 'story' : 'stories'}`);
    }
  }

  const failBlock = failReasons.length > 0
    ? `\n> ${failReasons.join(' · ')}\n`
    : '';

  const coveredRows = report.results.filter(r => r.covered).map(storyRow);
  const uncoveredRows = report.results.filter(r => !r.covered).map(storyRow);

  const tableHeader = `| | ID | Story | Evidence |\n|---|---|---|---|`;

  let body = `${COMMENT_MARKER}
## ${badge(coverage_percent, passed)} Locus Story Coverage

${statusLine}
${failBlock}`;

  if (coveredRows.length > 0) {
    body += `\n### ✅ Covered (${coveredRows.length})\n\n${tableHeader}\n${coveredRows.join('\n')}\n`;
  }

  if (uncoveredRows.length > 0) {
    body += `\n### ❌ Not covered (${uncoveredRows.length})\n\n${tableHeader}\n${uncoveredRows.join('\n')}\n`;
  }

  body += `\n---\n<sub>Powered by [Locus](https://prototyper.app) · [stories.yaml spec](https://github.com/jonybur/prototyper)</sub>`;

  return body;
}

/**
 * Posts or updates the Locus audit comment on the PR.
 * If a previous comment exists, edits it in place (idempotent).
 */
export async function postOrUpdateComment(
  githubToken: string,
  body: string
): Promise<void> {
  const context = github.context;
  const octokit = github.getOctokit(githubToken);

  if (!context.payload.pull_request) {
    core.warning('Not a PR context — skipping comment');
    return;
  }

  const prNumber = context.payload.pull_request.number;
  const { owner, repo } = context.repo;

  // Find existing Locus comment
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find(c => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.debug(`Updated existing Locus comment (id: ${existing.id})`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.debug(`Created new Locus comment on PR #${prNumber}`);
  }
}
