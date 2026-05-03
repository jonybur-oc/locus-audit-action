# locus/audit@v1

> GitHub Action: Locus story coverage audit for pull requests

Reads `stories.yaml` from your repo, fetches the PR diff, calls Claude to check which stories are addressed, and posts a coverage report as a PR comment.

![Locus Coverage](https://img.shields.io/badge/story%20coverage-87%25-brightgreen)

---

## Usage

```yaml
- uses: locus-dev/audit@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Full example:

```yaml
name: Locus Story Coverage

on:
  pull_request:
    branches: [main, develop]

jobs:
  story-coverage:
    name: Story coverage audit
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: locus-dev/audit@v1
        with:
          stories-path: stories.yaml
          min-coverage: 80
          fail-on-missing: false
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | ✅ | — | Anthropic API key for Claude analysis |
| `stories-path` | ❌ | `stories.yaml` | Path to stories file (relative to repo root) |
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
| `stories-covered` | Comma-separated list of covered story IDs |
| `stories-missing` | Comma-separated list of uncovered story IDs |
| `passed` | Whether the audit passed (`true`/`false`) |

---

## What it does

1. **Reads** `stories.yaml` from your repository (supports Locus spec v1.0 and v1.1)
2. **Fetches** the PR diff (files changed, patches) from the GitHub API
3. **Calls Claude** to evaluate which stories are addressed by the diff
4. **Posts a comment** on the PR with a coverage table:

```
✅ Locus Story Coverage — 87% (7/8 stories)

✅ Covered (7)
| ✅ | US-01 | User can log in with email/password | LoginForm.tsx implements fields |
| ✅ | US-02 | Error message on invalid email | validation.ts + LoginForm.tsx |
...

❌ Not covered (1)
| ❌ | US-08 | Password reset flow | No password reset code in this diff |
```

5. **Sets a check status** — pass or fail based on `min-coverage` and `fail-on-missing`

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

## The viral loop

Every PR where this runs shows the Locus badge in the comment. Every engineer on the team sees it. Word spreads.

The check is a lightweight signal: this PR addresses story coverage. Teams that adopt it report fewer scope-drift incidents and faster PM→engineer handoffs.

---

## Cost

Each PR audit costs roughly:
- `claude-haiku-4-5` (default): ~$0.001–0.005 per PR (very fast, cheap)
- `claude-sonnet-4-5`: ~$0.01–0.05 per PR (more accurate on complex stories)

For most repos with ≤20 stories, Haiku is accurate enough. Use Sonnet for critical paths.

---

## Contributing

Built on top of [Locus](https://prototyper.app) — the stories.yaml standard for AI-native product teams.

Issues: [github.com/locus-dev/audit](https://github.com/locus-dev/audit/issues)  
Spec: [github.com/jonybur/prototyper](https://github.com/jonybur/prototyper)

---

MIT © Jony Bursztyn
