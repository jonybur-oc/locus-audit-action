/**
 * Deterministic test_refs audit module (VON-101)
 *
 * Implements spec §7.11: when a story has test_refs, this module provides
 * a deterministic (non-AI) assessment of coverage by:
 *
 * 1. Checking that referenced test files exist in the repo (at head SHA)
 * 2. Optionally: scanning jest/cypress JSON test output for [story_id] patterns
 *    to determine whether tests passed for this story
 *
 * The result is combined with Claude's diff analysis in audit.ts:
 * - If test_refs gives a definitive pass result → set status 'satisfied' with high confidence
 * - If test_refs files are missing → set status 'not-covered' (deterministic, overrides Claude)
 * - If test output present but tests failed → set status 'diverged' (overrides Claude)
 * - Otherwise → fall through to Claude analysis
 *
 * Spec reference:
 * §7.11: "Audit tools SHOULD treat test_refs as the authoritative set of tests for
 * the story. When test_refs is present and non-empty, an audit tool MAY verify that
 * the referenced test files exist and that the tests pass."
 */

import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { Story } from './types';

/**
 * Outcome of checking a single test_ref file entry.
 */
export interface TestRefFileResult {
  /** Ref as written in stories.yaml e.g. "cypress/e2e/deposit.spec.ts#BT-07" */
  ref: string;
  /** File path portion (before #) */
  file: string;
  /** Optional story_id anchor (after #) */
  anchor?: string;
  /** Whether the file exists in the repo at head SHA */
  file_exists: boolean;
  /** Whether a matching test was found in test output (undefined if no output provided) */
  test_found?: boolean;
  /** Whether the matching test passed (undefined if not found or no output) */
  test_passed?: boolean;
}

/**
 * Summary verdict for one story's test_refs check.
 */
export type TestRefsVerdict =
  | 'pass'          // all files exist + (if output provided) all tests passed
  | 'fail'          // test output present and at least one test failed
  | 'missing-files' // one or more referenced files not found in repo
  | 'no-test-refs'  // story has no test_refs — no deterministic result
  | 'inconclusive'; // files exist but no test output to confirm pass/fail

export interface TestRefsResult {
  verdict: TestRefsVerdict;
  /** Per-ref breakdown */
  refs: TestRefFileResult[];
  /** Human-readable evidence string */
  evidence: string;
}

// ---------------------------------------------------------------------------
// Jest/Cypress JSON output types (minimal surface)
// ---------------------------------------------------------------------------

interface JestTestResult {
  testFilePath: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped';
  testResults: Array<{
    fullName: string;
    status: 'passed' | 'failed' | 'pending' | 'todo';
    ancestorTitles: string[];
    title: string;
  }>;
}

interface JestOutput {
  testResults: JestTestResult[];
}

// Cypress JSON report (from mochawesome or cypress-multi-reporters)
interface CypressTest {
  fullTitle: string;
  state: 'passed' | 'failed' | 'pending';
}

interface CypressSuite {
  title: string;
  fullTitle: string;
  tests: CypressTest[];
  suites?: CypressSuite[];
}

interface CypressReport {
  // mochawesome format
  results?: Array<{ suites: CypressSuite[] }>;
  // flat format
  stats?: { passes: number; failures: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a test_ref string into file and optional anchor.
 * e.g. "cypress/e2e/deposit.spec.ts#BT-07" → { file: "cypress/e2e/deposit.spec.ts", anchor: "BT-07" }
 */
function parseTestRef(ref: string): { file: string; anchor?: string } {
  const hashIdx = ref.indexOf('#');
  if (hashIdx === -1) {
    return { file: ref };
  }
  return {
    file: ref.slice(0, hashIdx),
    anchor: ref.slice(hashIdx + 1),
  };
}

/**
 * Recursively collect all test names from a Cypress suite tree.
 */
function collectCypressTests(suite: CypressSuite): CypressTest[] {
  const tests: CypressTest[] = [...(suite.tests ?? [])];
  for (const sub of suite.suites ?? []) {
    tests.push(...collectCypressTests(sub));
  }
  return tests;
}

/**
 * Load and parse test output JSON.
 * Supports jest JSON reporter format and cypress mochawesome JSON.
 * Returns null if file not found or parse fails.
 */
function loadTestOutput(testOutputPath: string): JestOutput | CypressReport | null {
  const absPath = path.resolve(process.cwd(), testOutputPath);
  if (!fs.existsSync(absPath)) {
    core.debug(`test-output-path not found: ${absPath}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    return JSON.parse(raw) as JestOutput | CypressReport;
  } catch (err) {
    core.warning(`Failed to parse test output at ${testOutputPath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Check whether a test named matching `[storyId]` exists and passed in jest output.
 * Returns { found, passed }.
 */
function findInJestOutput(output: JestOutput, storyId: string, filePath?: string): { found: boolean; passed?: boolean } {
  const pattern = `[${storyId}]`;
  let found = false;
  let allPassed = true;

  for (const fileResult of output.testResults ?? []) {
    // Optionally filter by file path
    if (filePath && !fileResult.testFilePath.endsWith(filePath)) {
      continue;
    }
    for (const t of fileResult.testResults ?? []) {
      if (t.fullName.includes(pattern) || t.title.includes(pattern)) {
        found = true;
        if (t.status !== 'passed') {
          allPassed = false;
        }
      }
    }
  }

  return found ? { found: true, passed: allPassed } : { found: false };
}

/**
 * Check whether a test named matching `[storyId]` exists and passed in Cypress output.
 */
function findInCypressOutput(output: CypressReport, storyId: string): { found: boolean; passed?: boolean } {
  const pattern = `[${storyId}]`;
  let found = false;
  let allPassed = true;

  const allTests: CypressTest[] = [];
  for (const result of output.results ?? []) {
    for (const suite of result.suites ?? []) {
      allTests.push(...collectCypressTests(suite));
    }
  }

  for (const t of allTests) {
    if (t.fullTitle.includes(pattern)) {
      found = true;
      if (t.state !== 'passed') {
        allPassed = false;
      }
    }
  }

  return found ? { found: true, passed: allPassed } : { found: false };
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

/**
 * Check whether files referenced in test_refs exist in the repo at head SHA.
 * Uses the GitHub contents API (works in CI without a local checkout).
 * Falls back to local filesystem check (works when running tests locally).
 */
async function checkFileExists(
  file: string,
  githubToken: string,
  headSha: string
): Promise<boolean> {
  // Try local filesystem first (works in local runs and in actions with checkout step)
  const localPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(localPath)) {
    return true;
  }

  // Try GitHub contents API
  try {
    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    await octokit.rest.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: file,
      ref: headSha,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the deterministic test_refs audit for a single story.
 *
 * @param story         The story to audit
 * @param githubToken   GitHub token for API calls
 * @param headSha       HEAD SHA of the PR branch
 * @param testOutput    Parsed test output (jest or cypress), or null
 */
export async function auditStoryTestRefs(
  story: Story,
  githubToken: string,
  headSha: string,
  testOutput: JestOutput | CypressReport | null
): Promise<TestRefsResult> {
  if (!story.test_refs || story.test_refs.length === 0) {
    return {
      verdict: 'no-test-refs',
      refs: [],
      evidence: 'story has no test_refs',
    };
  }

  const refResults: TestRefFileResult[] = [];

  for (const ref of story.test_refs) {
    const { file, anchor } = parseTestRef(ref);

    const fileExists = await checkFileExists(file, githubToken, headSha);

    let testFound: boolean | undefined;
    let testPassed: boolean | undefined;

    // Anchor is the story_id embedded in the test name (e.g. BT-07)
    const lookupId = anchor ?? story.story_id;

    if (testOutput && fileExists) {
      // Detect format: jest has testResults array with testFilePath;
      // cypress (mochawesome) has results array with suites
      const isJest = 'testResults' in testOutput &&
        Array.isArray((testOutput as JestOutput).testResults) &&
        (testOutput as JestOutput).testResults.length > 0 &&
        'testFilePath' in ((testOutput as JestOutput).testResults[0] ?? {});

      if (isJest) {
        const res = findInJestOutput(testOutput as JestOutput, lookupId, file);
        testFound = res.found;
        testPassed = res.passed;
      } else {
        const res = findInCypressOutput(testOutput as CypressReport, lookupId);
        testFound = res.found;
        testPassed = res.passed;
      }
    }

    refResults.push({
      ref,
      file,
      anchor,
      file_exists: fileExists,
      test_found: testFound,
      test_passed: testPassed,
    });
  }

  // Determine verdict
  const allFilesExist = refResults.every(r => r.file_exists);
  const anyFileMissing = refResults.some(r => !r.file_exists);
  const hasTestOutput = refResults.some(r => r.test_found !== undefined);
  const anyTestFailed = refResults.some(r => r.test_passed === false);
  const allTestsPassed = hasTestOutput && refResults.every(r => r.test_passed !== false);
  const anyTestFound = refResults.some(r => r.test_found === true);

  let verdict: TestRefsVerdict;
  let evidence: string;

  if (anyFileMissing) {
    const missing = refResults.filter(r => !r.file_exists).map(r => r.file).join(', ');
    verdict = 'missing-files';
    evidence = `test_refs file(s) not found in repo: ${missing}`;
  } else if (hasTestOutput && anyTestFailed) {
    const failed = refResults
      .filter(r => r.test_passed === false)
      .map(r => r.anchor ?? story.story_id)
      .join(', ');
    verdict = 'fail';
    evidence = `test(s) failed for [${failed}] in test output`;
  } else if (hasTestOutput && allTestsPassed && anyTestFound) {
    verdict = 'pass';
    const passCount = refResults.filter(r => r.test_passed).length;
    evidence = `${passCount}/${story.test_refs.length} test_ref(s) verified passing in test output`;
  } else if (allFilesExist && !hasTestOutput) {
    verdict = 'inconclusive';
    const fileList = refResults.map(r => r.file).join(', ');
    evidence = `test_refs files exist (${fileList}) — no test output to verify pass/fail`;
  } else {
    verdict = 'inconclusive';
    evidence = `test_refs checked — files exist but test name pattern [${story.story_id}] not found in output`;
  }

  return {
    verdict,
    refs: refResults,
    evidence,
  };
}

/**
 * Run test_refs audit for all stories that have test_refs.
 * Returns a map from story_id → TestRefsResult.
 */
export async function auditAllTestRefs(
  stories: Story[],
  githubToken: string,
  headSha: string,
  testOutputPath?: string
): Promise<Map<string, TestRefsResult>> {
  const storiesWithRefs = stories.filter(s => s.test_refs && s.test_refs.length > 0);

  if (storiesWithRefs.length === 0) {
    core.debug('No stories have test_refs — skipping deterministic audit');
    return new Map();
  }

  core.info(`🔬 Running deterministic test_refs audit for ${storiesWithRefs.length} stories with test_refs`);

  // Load test output once
  let testOutput: JestOutput | CypressReport | null = null;
  if (testOutputPath) {
    testOutput = loadTestOutput(testOutputPath);
    if (testOutput) {
      core.info(`📊 Loaded test output from ${testOutputPath}`);
    }
  }

  const results = new Map<string, TestRefsResult>();

  // Run checks in parallel (bounded — GitHub API may rate-limit)
  const CONCURRENCY = 5;
  for (let i = 0; i < storiesWithRefs.length; i += CONCURRENCY) {
    const batch = storiesWithRefs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(story => auditStoryTestRefs(story, githubToken, headSha, testOutput))
    );
    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j].story_id, batchResults[j]);
    }
  }

  const passCount = [...results.values()].filter(r => r.verdict === 'pass').length;
  const failCount = [...results.values()].filter(r => r.verdict === 'fail').length;
  const missingCount = [...results.values()].filter(r => r.verdict === 'missing-files').length;
  const inconclusiveCount = [...results.values()].filter(r => r.verdict === 'inconclusive').length;

  core.info(
    `🔬 test_refs audit complete: ${passCount} pass, ${failCount} fail, ${missingCount} missing-files, ${inconclusiveCount} inconclusive`
  );

  return results;
}
