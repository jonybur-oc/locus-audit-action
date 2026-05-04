import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { Story, StoryAuditResult, AuditReport, AcResult } from './types';
import { PrDiff } from './get-diff';
import { TestRefsResult } from './test-refs-audit';

const SYSTEM_PROMPT = `You are a story divergence auditor. Given a PR diff and a list of user stories with acceptance criteria, determine:

1. Which stories this PR **satisfies** (all acceptance criteria met by changes in the diff)
2. Which stories are **partial** (some ACs met, none contradicted)
3. Which stories are **not-covered** (diff doesn't touch this story at all)
4. Which stories are **diverged** (diff actively contradicts or bypasses at least one acceptance criterion)

Definitions:
- **satisfied**: The diff implements the described functionality in a way consistent with ALL acceptance criteria. 
- **partial**: The diff advances some acceptance criteria but not all, and none are violated.
- **not-covered**: This PR touches none of the files or logic related to this story.
- **diverged**: The diff introduces code that bypasses, disables, or contradicts one or more acceptance criteria. E.g. removing an auth check that was an AC, or hardcoding a value the AC says must be dynamic.

Be surgical: a story is only "diverged" if code ACTIVELY contradicts the story, not merely if it's incomplete.

Respond ONLY with valid JSON. No markdown fences, no explanation outside the JSON.`;

interface ClaudeAcResult {
  criterion: string;
  status: 'satisfied' | 'partial' | 'not-covered' | 'diverged';
  evidence: string;
}

interface ClaudeStoryResult {
  story_id: string;
  status: 'satisfied' | 'partial' | 'not-covered' | 'diverged';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  files_touched: string[];
  ac_results?: ClaudeAcResult[];
}

interface ClaudeAuditResponse {
  results: ClaudeStoryResult[];
}

/**
 * Status values that should be excluded from the Claude audit.
 *
 * - 'deprecated': spec rule 8.1.5 — audit tools MUST NOT flag deprecated stories
 *   as diverged or uncovered. Excluded entirely.
 * - 'in-progress': set by humans to signal active development. Sending to Claude
 *   is noise — the code is intentionally incomplete. Excluded from coverage calc.
 * - 'implemented': already done; skip unless the PR could regress it (future work).
 *
 * Stories with these statuses are returned as 'skipped' results so the comment
 * can display them in a separate collapsed section.
 */
const SKIP_STATUSES = new Set(['deprecated', 'in-progress', 'implemented']);

/**
 * Calls Claude to audit divergence and coverage for all stories against the PR diff.
 * Stories with skip-statuses (deprecated, in-progress, implemented) are excluded
 * from the Claude call and returned with status='skipped'.
 *
 * @param testRefsResults Optional map from story_id → TestRefsResult from deterministic audit.
 *   When present, stories with deterministic pass/fail verdicts are resolved without Claude.
 *   Stories with 'missing-files' verdict get status='not-covered' (deterministic override).
 *   Stories with 'inconclusive' verdict still go through Claude but include test_refs context.
 */
export async function auditStoriesWithClaude(
  stories: Story[],
  diff: PrDiff,
  apiKey: string,
  model: string,
  testRefsResults?: Map<string, TestRefsResult>
): Promise<StoryAuditResult[]> {
  const client = new Anthropic({ apiKey });

  // Split stories into auditable vs skipped
  const auditable = stories.filter(s => !SKIP_STATUSES.has(s.status ?? ''));
  const skipped   = stories.filter(s => SKIP_STATUSES.has(s.status ?? ''));

  // ── Deterministic test_refs pre-pass ──────────────────────────────────────
  // Resolve stories that have definitive test_refs verdicts before calling Claude.
  const deterministicResults: StoryAuditResult[] = [];
  const needsClaudeAudit: Story[] = [];

  for (const story of auditable) {
    const tr = testRefsResults?.get(story.story_id);

    if (!tr || tr.verdict === 'no-test-refs') {
      // No test_refs — Claude handles it
      needsClaudeAudit.push(story);
      continue;
    }

    if (tr.verdict === 'pass') {
      // Definitive: test_refs files exist AND tests passed → satisfied
      deterministicResults.push({
        story,
        status: 'satisfied',
        covered: true,
        confidence: 'high',
        evidence: `[deterministic] ${tr.evidence}`,
        files_touched: tr.refs.map(r => r.file),
        test_refs_result: tr,
      });
      core.debug(`${story.story_id}: deterministic pass (test_refs)`);
    } else if (tr.verdict === 'fail') {
      // Definitive: test output present and tests failed → diverged
      deterministicResults.push({
        story,
        status: 'diverged',
        covered: false,
        confidence: 'high',
        evidence: `[deterministic] ${tr.evidence}`,
        files_touched: tr.refs.map(r => r.file),
        test_refs_result: tr,
      });
      core.debug(`${story.story_id}: deterministic fail (test_refs)`);
    } else if (tr.verdict === 'missing-files') {
      // Definitive: referenced test files don't exist → not-covered
      deterministicResults.push({
        story,
        status: 'not-covered',
        covered: false,
        confidence: 'high',
        evidence: `[deterministic] ${tr.evidence}`,
        files_touched: [],
        test_refs_result: tr,
      });
      core.debug(`${story.story_id}: deterministic missing-files (test_refs)`);
    } else {
      // 'inconclusive' — files exist but no test output. Pass to Claude with extra context.
      needsClaudeAudit.push(story);
    }
  }

  if (deterministicResults.length > 0) {
    core.info(
      `🔬 ${deterministicResults.length} ${deterministicResults.length === 1 ? 'story' : 'stories'} resolved deterministically via test_refs — ` +
      `${needsClaudeAudit.length} sent to Claude`
    );
  }

  core.debug(`Auditing ${needsClaudeAudit.length} stories via Claude; ${deterministicResults.length} resolved deterministically; skipping ${skipped.length} (deprecated/in-progress/implemented)`);

  // Return early if nothing to audit via Claude
  if (needsClaudeAudit.length === 0) {
    const skippedResults = skipped.map(story => ({
      story,
      status: 'skipped' as const,
      covered: false,
      confidence: 'high' as const,
      evidence: `skipped — story status is '${story.status}'`,
      files_touched: [],
    }));
    return [...deterministicResults, ...skippedResults];
  }

  // Build a compact story list for the prompt
  const storyList = needsClaudeAudit.map(s => {
    const lines: string[] = [`story_id: ${s.story_id}`, `title: ${s.title}`];
    if (s.description) lines.push(`description: ${s.description.slice(0, 200)}`);
    if (s.acceptance_criteria?.length) {
      lines.push(`acceptance_criteria:\n${s.acceptance_criteria.map(ac => `  - ${ac}`).join('\n')}`);
    }
    if (s.as_a) lines.push(`as_a: ${s.as_a}`);
    if (s.i_want) lines.push(`i_want: ${s.i_want}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  // Annotate stories with inconclusive test_refs context so Claude can use it
  const inconclusiveContext = needsClaudeAudit
    .filter(s => testRefsResults?.get(s.story_id)?.verdict === 'inconclusive')
    .map(s => {
      const tr = testRefsResults!.get(s.story_id)!;
      return `${s.story_id}: test_refs files exist (${tr.refs.map(r => r.file).join(', ')}) but no test output to confirm pass/fail`;
    });

  const inconclusiveNote = inconclusiveContext.length > 0
    ? `\n## test_refs context (deterministic file check)\n${inconclusiveContext.join('\n')}\n`
    : '';

  const userPrompt = `## Stories to audit (${needsClaudeAudit.length} total)

${storyList}
${inconclusiveNote}
## PR Diff (PR #${diff.pr_number})

Files changed: ${diff.files.map(f => f.filename).join(', ')}

${diff.full_diff || '[no patch data available]'}

## Task

For each story, determine: satisfied / partial / not-covered / diverged.
If the story has acceptance_criteria, also audit each criterion individually.

Respond with this exact JSON structure:
{
  "results": [
    {
      "story_id": "US-01",
      "status": "satisfied",
      "confidence": "high",
      "evidence": "LoginForm.tsx implements email+password fields and token storage as described",
      "files_touched": ["src/components/LoginForm.tsx"],
      "ac_results": [
        {
          "criterion": "User can submit email and password",
          "status": "satisfied",
          "evidence": "LoginForm renders <input type=email> and <input type=password>"
        }
      ]
    }
  ]
}

Include ALL ${needsClaudeAudit.length} stories. Omit ac_results if the story has no acceptance_criteria.`;

  core.debug(`Calling ${model} to audit ${needsClaudeAudit.length} stories (divergence mode) against PR #${diff.pr_number}`);

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('unexpected response type from Claude');
  }

  let parsed: ClaudeAuditResponse;
  try {
    // Strip markdown fences if model includes them despite instructions
    const jsonText = content.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(jsonText) as ClaudeAuditResponse;
  } catch {
    core.debug(`Raw Claude response: ${content.text.slice(0, 500)}`);
    throw new Error(`Claude returned invalid JSON: ${content.text.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.results)) {
    throw new Error(`Claude response missing results array`);
  }

  // Map results back to Story objects, filling in any stories Claude missed
  // Accept both story_id (canonical) and id (legacy) in Claude responses
  const resultMap = new Map<string, ClaudeStoryResult>();
  for (const r of parsed.results) {
    resultMap.set(r.story_id, r);
  }

  const auditedResults = needsClaudeAudit.map(story => {
    const r = resultMap.get(story.story_id);
    if (!r) {
      return {
        story,
        status: 'not-covered' as const,
        covered: false,
        confidence: 'low' as const,
        evidence: 'story not evaluated by auditor',
        files_touched: [],
      };
    }

    const acResults: AcResult[] | undefined = r.ac_results?.map(ac => ({
      criterion: ac.criterion,
      status: ac.status,
      evidence: ac.evidence,
    }));

    const acTotal = acResults?.length ?? 0;
    const acSatisfied = acResults?.filter(ac => ac.status === 'satisfied').length ?? 0;

    // Attach test_refs_result for inconclusive stories (files exist, no test output)
    const tr = testRefsResults?.get(story.story_id);

    return {
      story,
      status: r.status,
      covered: r.status === 'satisfied' || r.status === 'partial',
      confidence: r.confidence,
      evidence: r.evidence,
      files_touched: r.files_touched,
      ac_results: acResults,
      acs_satisfied: acTotal > 0 ? acSatisfied : undefined,
      acs_total: acTotal > 0 ? acTotal : undefined,
      test_refs_result: tr?.verdict === 'inconclusive' ? tr : undefined,
    };
  });

  // Append skipped stories (deprecated / in-progress / implemented)
  const skippedResults: StoryAuditResult[] = skipped.map(story => ({
    story,
    status: 'skipped' as const,
    covered: false,
    confidence: 'high' as const,
    evidence: `skipped — story status is '${story.status}'`,
    files_touched: [],
  }));

  // Merge: deterministic results first, then Claude-audited, then skipped
  return [...deterministicResults, ...auditedResults, ...skippedResults];
}

/**
 * Builds the AuditReport from raw story results and action config.
 * Skipped stories (deprecated / in-progress / implemented) are excluded from
 * coverage calculations per spec rules 8.1.5 and 8.1.6.
 */
export function buildReport(
  results: StoryAuditResult[],
  minCoverage: number,
  failOnMissing: boolean,
  failOnDivergence: boolean
): AuditReport {
  // Exclude skipped stories from all metrics
  const audited = results.filter(r => r.status !== 'skipped');
  const total = audited.length;
  const covered = audited.filter(r => r.covered).length;
  const uncovered = audited.filter(r => r.status === 'not-covered').length;
  const diverged = audited.filter(r => r.status === 'diverged').length;
  const coverage_percent = total === 0 ? 100 : Math.round((covered / total) * 100);

  const coveragePasses = coverage_percent >= minCoverage;
  const missingPasses = !failOnMissing || uncovered === 0;
  const divergencePasses = !failOnDivergence || diverged === 0;
  const passed = coveragePasses && missingPasses && divergencePasses;

  return {
    total,
    covered,
    uncovered,
    diverged,
    coverage_percent,
    results,
    passed,
    min_coverage: minCoverage,
    fail_on_missing: failOnMissing,
    fail_on_divergence: failOnDivergence,
  };
}
