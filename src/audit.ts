import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { Story, StoryAuditResult, AuditReport, AcResult } from './types';
import { PrDiff } from './get-diff';

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
  id: string;
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
 */
export async function auditStoriesWithClaude(
  stories: Story[],
  diff: PrDiff,
  apiKey: string,
  model: string
): Promise<StoryAuditResult[]> {
  const client = new Anthropic({ apiKey });

  // Split stories into auditable vs skipped
  const auditable = stories.filter(s => !SKIP_STATUSES.has(s.status ?? ''));
  const skipped   = stories.filter(s => SKIP_STATUSES.has(s.status ?? ''));

  core.debug(`Auditing ${auditable.length} stories; skipping ${skipped.length} (deprecated/in-progress/implemented)`);

  // Return early if nothing to audit
  if (auditable.length === 0) {
    return skipped.map(story => ({
      story,
      status: 'skipped' as const,
      covered: false,
      confidence: 'high' as const,
      evidence: `skipped — story status is '${story.status}'`,
      files_touched: [],
    }));
  }

  // Build a compact story list for the prompt
  const storyList = auditable.map(s => {
    const lines: string[] = [`id: ${s.id}`, `title: ${s.title}`];
    if (s.description) lines.push(`description: ${s.description.slice(0, 200)}`);
    if (s.acceptance_criteria?.length) {
      lines.push(`acceptance_criteria:\n${s.acceptance_criteria.map(ac => `  - ${ac}`).join('\n')}`);
    }
    if (s.as_a) lines.push(`as_a: ${s.as_a}`);
    if (s.i_want) lines.push(`i_want: ${s.i_want}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const userPrompt = `## Stories to audit (${auditable.length} total)

${storyList}

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
      "id": "US-01",
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

Include ALL ${auditable.length} stories. Omit ac_results if the story has no acceptance_criteria.`;

  core.debug(`Calling ${model} to audit ${auditable.length} stories (divergence mode) against PR #${diff.pr_number}`);

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
  const resultMap = new Map<string, ClaudeStoryResult>();
  for (const r of parsed.results) {
    resultMap.set(r.id, r);
  }

  const auditedResults = auditable.map(story => {
    const r = resultMap.get(story.id);
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

  return [...auditedResults, ...skippedResults];
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
