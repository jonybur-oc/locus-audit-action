import * as github from '@actions/github';
import * as core from '@actions/core';
import { AuditReport, StoryAuditResult } from './types';

const COMMENT_MARKER = '<!-- locus-audit-action -->';

function badge(percent: number, passed: boolean, hasDivergence: boolean): string {
  const color = hasDivergence ? 'critical' : passed ? 'brightgreen' : percent >= 50 ? 'yellow' : 'red';
  return `![Locus Coverage](https://img.shields.io/badge/story%20coverage-${percent}%25-${color}?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik05IDEyLjVsLTMuNS0zLjUtMS41IDEuNUw5IDE1LjVsMTAtMTAtMS41LTEuNXoiLz48L3N2Zz4=)`;
}

/** Icon for story-level status */
function statusIcon(status: StoryAuditResult['status']): string {
  switch (status) {
    case 'satisfied':   return '✅';
    case 'partial':     return '⚠️';
    case 'not-covered': return '—';
    case 'diverged':    return '❌';
  }
}

/** Short label for story-level status */
function statusLabel(r: StoryAuditResult): string {
  switch (r.status) {
    case 'satisfied':   return 'satisfied';
    case 'partial': {
      const frac = (r.acs_satisfied !== undefined && r.acs_total !== undefined)
        ? ` (${r.acs_satisfied}/${r.acs_total} ACs covered)`
        : '';
      return `partial${frac}`;
    }
    case 'not-covered': return 'not covered';
    case 'diverged':    return `diverged — ${r.evidence.slice(0, 80)}`;
  }
}

function storyRow(r: StoryAuditResult): string {
  const icon = statusIcon(r.status);
  const label = statusLabel(r);
  const conf = r.confidence === 'high' ? '' : ` _(${r.confidence})_`;
  const files = r.files_touched.length > 0
    ? `<br><sub>${r.files_touched.slice(0, 3).join(', ')}${r.files_touched.length > 3 ? ` +${r.files_touched.length - 3} more` : ''}</sub>`
    : '';
  return `| ${icon} | \`${r.story.id}\` | ${r.story.title}${conf} | ${label}${files} |`;
}

export function buildCommentBody(report: AuditReport): string {
  const { coverage_percent, covered, total, passed, min_coverage, fail_on_missing, fail_on_divergence, diverged } = report;
  const hasDivergence = diverged > 0;

  const affectedCount = report.results.filter(r => r.status !== 'not-covered').length;

  const headerLine = affectedCount > 0
    ? `Locus Audit — ${affectedCount} ${affectedCount === 1 ? 'story' : 'stories'} affected by this PR`
    : 'Locus Audit — no stories affected by this PR';

  const statusLine = passed
    ? `✅ **Audit passed** — ${coverage_percent}% story coverage (${covered}/${total})`
    : hasDivergence
      ? `❌ **Audit failed** — ${diverged} ${diverged === 1 ? 'story' : 'stories'} diverged from spec`
      : `❌ **Audit failed** — ${coverage_percent}% story coverage (${covered}/${total})`;

  const failReasons: string[] = [];
  if (!passed) {
    if (hasDivergence && fail_on_divergence) {
      failReasons.push(`${diverged} diverged ${diverged === 1 ? 'story' : 'stories'}`);
    }
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

  const tableHeader = `| | ID | Story | Status |\n|---|---|---|---|`;

  // Group stories by status for display
  const divergedRows   = report.results.filter(r => r.status === 'diverged').map(storyRow);
  const partialRows    = report.results.filter(r => r.status === 'partial').map(storyRow);
  const satisfiedRows  = report.results.filter(r => r.status === 'satisfied').map(storyRow);
  const notCoveredRows = report.results.filter(r => r.status === 'not-covered').map(storyRow);

  let body = `${COMMENT_MARKER}
## ${badge(coverage_percent, passed, hasDivergence)} ${headerLine}

${statusLine}
${failBlock}`;

  if (divergedRows.length > 0) {
    body += `\n### ❌ Diverged (${divergedRows.length})\n\n${tableHeader}\n${divergedRows.join('\n')}\n`;
  }

  if (partialRows.length > 0) {
    body += `\n### ⚠️ Partial (${partialRows.length})\n\n${tableHeader}\n${partialRows.join('\n')}\n`;
  }

  if (satisfiedRows.length > 0) {
    body += `\n### ✅ Satisfied (${satisfiedRows.length})\n\n${tableHeader}\n${satisfiedRows.join('\n')}\n`;
  }

  if (notCoveredRows.length > 0) {
    // Collapse not-covered to keep comment clean — use a <details> block
    body += `\n<details>\n<summary>— Not covered by this PR (${notCoveredRows.length})</summary>\n\n${tableHeader}\n${notCoveredRows.join('\n')}\n\n</details>\n`;
  }

  const coverageLine = `Coverage: ${covered}/${total} stories (${coverage_percent}%)`;
  body += `\n---\n<sub>${coverageLine} · Powered by [Locus](https://prototyper.app) · [stories.yaml spec](https://github.com/jonybur/locus)</sub>`;

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
