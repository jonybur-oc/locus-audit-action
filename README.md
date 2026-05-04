# Locus Story Coverage Audit

> GitHub Action: Locus story divergence & coverage audit for pull requests

Reads `stories.yaml` from your repo, fetches the PR diff, calls Claude to check which stories are satisfied, partial, or **diverged**, and posts a structured report as a PR comment.

![Locus Coverage](https://img.shields.io/badge/story%20coverage-87%25-brightgreen)

---

## Usage

```yaml
- uses: jonybur-oc/locus-audit-action@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Full example:

```yaml
name: Locus Story Audit

on:
  pull_request:
    branches: [main, develop]

jobs:
  story-audit:
    name: Story divergence audit
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: jonybur-oc/locus-audit-action@v1
        with:
          stories-path: stories.yaml
          fail-on-divergence: false   # informational by default
          min-coverage: 0             # no threshold by default
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | ✅ | — | Anthropic API key for Claude analysis |
| `stories-path` | ❌ | `stories.yaml` | Path to stories file (relative to repo root) |
| `fail-on-divergence` | ❌ | `false` | Fail if any stories are **diverged** (code contradicts spec) |
| `min-coverage` | ❌ | `0` | Minimum required coverage % (0 = report only, don't fail) |
| `fail-on-missing` | ❌ | `false` | Fail if any stories are completely uncovered |
| `github-token` | ❌ | `${{ github.token }}` | Token for posting PR comments |
| `model` | ❌ | `claude-haiku-4-5` | Claude model for analysis |
| `status-only` | ❌ | `false` | Skip PR comment, only set step outputs |

---

## Outputs

| Output | Description |
|--------|-------------|
| `coverage-percent` | Story coverage percentage (integer 0–100) |
| `stories-covered` | Comma-separated list of covered story IDs (satisfied or partial) |
| `stories-missing` | Comma-separated list of uncovered story IDs |
| `stories-diverged` | Comma-separated list of story IDs that diverged from spec |
| `passed` | Whether the audit passed (`true`/`false`) |

---

## What it does

1. **Reads** `stories.yaml` from your repository
2. **Fetches** the PR diff (files changed, patches) from the GitHub API
3. **Calls Claude** to evaluate each story against the diff — checking not just coverage but divergence
4. **Posts a comment** on the PR with a structured report:

```
✅ Locus Audit — 3 stories affected by this PR

✅ BT-07  User can broadcast pre-peg-in transaction   — satisfied
⚠️  BT-08  User can sign payout transactions           — partial (2/4 ACs covered)  
❌ BT-05  User can sign proof-of-possession            — diverged (code bypasses BIP-322)

Coverage: 21/23 stories (91%)
```

5. **Sets a check status** — pass or fail based on `fail-on-divergence`, `min-coverage`, and `fail-on-missing`

---

## Story status definitions

| Status | Meaning |
|--------|---------|
| ✅ **satisfied** | All acceptance criteria addressed by this PR |
| ⚠️ **partial** | Some ACs covered, none contradicted |
| — **not-covered** | PR doesn't touch this story (collapsed by default) |
| ❌ **diverged** | Diff actively contradicts or bypasses at least one AC |

**Diverged** is the critical signal: it means code is drifting from intent. E.g. removing an auth check that was an acceptance criterion, or hardcoding a value the spec says must be dynamic.

---

## Two modes

**Informational (default)** — posts the report but never blocks the PR. Low-friction adoption.

```yaml
- uses: jonybur-oc/locus-audit-action@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    fail-on-divergence: false
```

**Enforced (opt-in)** — blocks the PR when stories diverge. For compliance teams.

```yaml
- uses: jonybur-oc/locus-audit-action@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    fail-on-divergence: true
    min-coverage: 80
```

---

## The stories.yaml format

This action reads the [Locus stories.yaml spec](https://github.com/jonybur/prototyper). 
Both v1.0 (basic) and v1.1 (with acceptance_criteria, depends_on, design_ref, test_refs) are supported.

Minimal example:

```yaml
- id: US-01
  title: User can log in with email/password
  description: Standard email + password login form
  status: not-implemented

- id: US-02  
  title: Error message shown if email format is invalid
  acceptance_criteria:
    - Error message appears within 2s
    - Error message is red and placed below the input
  status: not-implemented
```

Full spec: [locus spec v1.1](https://github.com/jonybur/prototyper/blob/main/docs/specification/locus-spec-v1.0.md)

---

## Cost

Each PR audit costs roughly:
- `claude-haiku-4-5` (default): ~$0.001–0.005 per PR
- `claude-sonnet-4-5`: ~$0.01–0.05 per PR (more accurate on complex stories)

For most repos with ≤20 stories, Haiku is accurate enough. Use Sonnet for critical or compliance paths.

---

## Contributing

Built on top of [Locus](https://prototyper.app) — the stories.yaml standard for AI-native product teams.

Issues: [github.com/jonybur-oc/locus-audit-action](https://github.com/jonybur-oc/locus-audit-action/issues)  
Spec: [github.com/jonybur/prototyper](https://github.com/jonybur/prototyper)

---

MIT © Jony Bursztyn
