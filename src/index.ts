/**
 * Locus Story Coverage Audit — GitHub Action
 *
 * Reads stories.yaml, fetches the PR diff, calls Claude to check coverage
 * and divergence, posts a structured comment on the PR, and optionally
 * fails the check.
 */

import * as core from '@actions/core';
import { ActionInputs } from './types';
import { parseStoriesFile } from './parse-stories';
import { getPrDiff } from './get-diff';
import { auditStoriesWithClaude, buildReport } from './audit';
import { buildCommentBody, postOrUpdateComment } from './comment';

async function run(): Promise<void> {
  const inputs: ActionInputs = {
    storiesPath: core.getInput('stories-path') || 'stories.yaml',
    minCoverage: parseInt(core.getInput('min-coverage') || '0', 10),
    failOnMissing: core.getInput('fail-on-missing') === 'true',
    failOnDivergence: core.getInput('fail-on-divergence') === 'true',
    anthropicApiKey: core.getInput('anthropic-api-key', { required: true }),
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN || '',
    model: core.getInput('model') || 'claude-haiku-4-5',
    statusOnly: core.getInput('status-only') === 'true',
  };

  core.debug(`stories-path: ${inputs.storiesPath}`);
  core.debug(`min-coverage: ${inputs.minCoverage}`);
  core.debug(`fail-on-missing: ${inputs.failOnMissing}`);
  core.debug(`fail-on-divergence: ${inputs.failOnDivergence}`);
  core.debug(`model: ${inputs.model}`);

  // 1. Parse stories.yaml
  core.info(`📖 Reading stories from ${inputs.storiesPath}`);
  let stories;
  try {
    stories = parseStoriesFile(inputs.storiesPath);
  } catch (err) {
    core.setFailed(`Failed to parse stories file: ${(err as Error).message}`);
    return;
  }

  if (stories.length === 0) {
    core.warning('No stories found in stories file — nothing to audit');
    core.setOutput('coverage-percent', '100');
    core.setOutput('stories-covered', '');
    core.setOutput('stories-missing', '');
    core.setOutput('stories-diverged', '');
    core.setOutput('passed', 'true');
    return;
  }

  core.info(`📋 Found ${stories.length} stories`);

  // 2. Fetch PR diff
  core.info('🔍 Fetching PR diff...');
  let diff;
  try {
    diff = await getPrDiff(inputs.githubToken);
  } catch (err) {
    core.setFailed(`Failed to fetch PR diff: ${(err as Error).message}`);
    return;
  }

  core.info(`📁 PR #${diff.pr_number} touches ${diff.files.length} files`);

  if (diff.files.length === 0) {
    core.warning('PR has no file changes — coverage is 0%');
  }

  // 3. Audit with Claude (divergence + coverage)
  core.info(`🤖 Auditing with ${inputs.model}...`);
  let auditResults;
  try {
    auditResults = await auditStoriesWithClaude(
      stories,
      diff,
      inputs.anthropicApiKey,
      inputs.model
    );
  } catch (err) {
    core.setFailed(`Claude audit failed: ${(err as Error).message}`);
    return;
  }

  // 4. Build report
  const report = buildReport(
    auditResults,
    inputs.minCoverage,
    inputs.failOnMissing,
    inputs.failOnDivergence
  );

  const divergedIds = auditResults.filter(r => r.status === 'diverged').map(r => r.story.id);
  if (divergedIds.length > 0) {
    core.warning(`⚠️  Diverged stories: ${divergedIds.join(', ')}`);
  }

  core.info(`📊 Coverage: ${report.coverage_percent}% (${report.covered}/${report.total}) — ${report.diverged} diverged`);

  // 5. Set outputs
  core.setOutput('coverage-percent', String(report.coverage_percent));
  core.setOutput('stories-covered', auditResults.filter(r => r.covered).map(r => r.story.id).join(','));
  core.setOutput('stories-missing', auditResults.filter(r => r.status === 'not-covered').map(r => r.story.id).join(','));
  core.setOutput('stories-diverged', divergedIds.join(','));
  core.setOutput('passed', String(report.passed));

  // 6. Post PR comment (unless status-only)
  if (!inputs.statusOnly) {
    core.info('💬 Posting coverage comment...');
    try {
      const commentBody = buildCommentBody(report);
      await postOrUpdateComment(inputs.githubToken, commentBody);
    } catch (err) {
      // Non-fatal — log warning but don't fail the action for a comment failure
      core.warning(`Failed to post PR comment: ${(err as Error).message}`);
    }
  }

  // 7. Fail check if configured
  if (!report.passed) {
    const reasons: string[] = [];
    if (report.diverged > 0 && inputs.failOnDivergence) {
      reasons.push(`${report.diverged} diverged ${report.diverged === 1 ? 'story' : 'stories'} (${divergedIds.join(', ')})`);
    }
    if (report.coverage_percent < inputs.minCoverage) {
      reasons.push(`coverage ${report.coverage_percent}% < required ${inputs.minCoverage}%`);
    }
    if (inputs.failOnMissing && report.uncovered > 0) {
      reasons.push(`${report.uncovered} uncovered ${report.uncovered === 1 ? 'story' : 'stories'}`);
    }
    core.setFailed(`Locus audit failed: ${reasons.join('; ')}`);
  } else {
    core.info('✅ Locus audit passed');
  }
}

run().catch(err => core.setFailed(`Unexpected error: ${(err as Error).message}`));
