import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { Story, StoryAuditResult, AuditReport } from './types';
import { PrDiff } from './get-diff';

const SYSTEM_PROMPT = `You are a story coverage auditor. Given a PR diff and a list of user stories, 
determine which stories are addressed by the changes in the diff.

A story is "covered" if:
- The diff contains code changes that implement the story's described functionality, OR
- The diff contains test code that validates the story's acceptance criteria, OR
- The diff contains meaningful progress toward the story (partial implementations count)

A story is NOT covered if:
- The diff only touches unrelated files (docs, config, other features)
- The diff contains no code relevant to the story's functionality

Be pragmatic: small PRs legitimately touch only a subset of stories. 
Focus on whether this specific diff advances the story, not whether the story is complete.

Respond ONLY with valid JSON. No markdown fences, no explanation outside the JSON.`;

interface ClaudeStoryResult {
  id: string;
  covered: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  files_touched: string[];
}

interface ClaudeAuditResponse {
  results: ClaudeStoryResult[];
}

/**
 * Calls Claude to audit which stories are covered by the PR diff.
 */
export async function auditStoriesWithClaude(
  stories: Story[],
  diff: PrDiff,
  apiKey: string,
  model: string
): Promise<StoryAuditResult[]> {
  const client = new Anthropic({ apiKey });

  // Build a compact story list for the prompt
  const storyList = stories.map(s => {
    const lines: string[] = [`id: ${s.id}`, `title: ${s.title}`];
    if (s.description) lines.push(`description: ${s.description.slice(0, 200)}`);
    if (s.acceptance_criteria?.length) {
      lines.push(`acceptance_criteria:\n${s.acceptance_criteria.map(ac => `  - ${ac}`).join('\n')}`);
    }
    if (s.as_a) lines.push(`as_a: ${s.as_a}`);
    if (s.i_want) lines.push(`i_want: ${s.i_want}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const userPrompt = `## Stories to audit (${stories.length} total)

${storyList}

## PR Diff (PR #${diff.pr_number})

Files changed: ${diff.files.map(f => f.filename).join(', ')}

${diff.full_diff || '[no patch data available]'}

## Task

For each story, determine if this PR diff covers it.

Respond with this exact JSON structure:
{
  "results": [
    {
      "id": "US-01",
      "covered": true,
      "confidence": "high",
      "evidence": "LoginForm.tsx implements the email/password fields described in the story",
      "files_touched": ["src/components/LoginForm.tsx", "src/api/auth.ts"]
    }
  ]
}

Include ALL ${stories.length} stories in your results array, in any order.`;

  core.debug(`Calling ${model} to audit ${stories.length} stories against PR #${diff.pr_number}`);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('unexpected response type from Claude');
  }

  let parsed: ClaudeAuditResponse;
  try {
    parsed = JSON.parse(content.text) as ClaudeAuditResponse;
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

  return stories.map(story => {
    const r = resultMap.get(story.id);
    if (!r) {
      // Claude missed this story — mark as uncovered with low confidence
      return {
        story,
        covered: false,
        confidence: 'low' as const,
        evidence: 'story not evaluated by auditor',
        files_touched: [],
      };
    }
    return {
      story,
      covered: r.covered,
      confidence: r.confidence,
      evidence: r.evidence,
      files_touched: r.files_touched,
    };
  });
}

/**
 * Builds the AuditReport from raw story results and action config.
 */
export function buildReport(
  results: StoryAuditResult[],
  minCoverage: number,
  failOnMissing: boolean
): AuditReport {
  const total = results.length;
  const covered = results.filter(r => r.covered).length;
  const uncovered = total - covered;
  const coverage_percent = total === 0 ? 100 : Math.round((covered / total) * 100);

  const coveragePasses = coverage_percent >= minCoverage;
  const missingPasses = !failOnMissing || uncovered === 0;
  const passed = coveragePasses && missingPasses;

  return {
    total,
    covered,
    uncovered,
    coverage_percent,
    results,
    passed,
    min_coverage: minCoverage,
    fail_on_missing: failOnMissing,
  };
}
