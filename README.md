# BCForge Check — GitHub Action

Validates AL object ID ranges and governance rules against your BCForge workspace configuration on every push and pull request. Results are posted as GitHub annotations and recorded in your BCForge CI runs history.

## What it does

1. Reads your workspace config from `.bcforge.json` at the repo root
2. Fetches your active rules and range pool from BCForge
3. Scans all `.al` files in the repository
4. Checks for rule violations (TODO comments, obsolete tags, missing captions, oversized functions, …)
5. Checks that every AL object ID falls inside your organisation's pool and doesn't conflict with another workspace
6. Posts inline annotations on the PR diff for every violation
7. Pushes the discovered app ranges and object IDs back to BCForge to keep the web UI in sync
8. Records a run entry in your BCForge CI history with status, counts, and full annotation detail

Source code never leaves your CI runner — BCForge only receives metadata.

## Quick start

Add a `.bcforge.json` to your repo root (BCForge creates this for you via **Settings → GitHub → Create setup PR**):

```json
{
  "org": "<your-org-uuid>",
  "workspace": "<your-workspace-uuid>"
}
```

Create a CI API key in BCForge (**Settings → CI / CD Keys**), add it as a repository secret named `BCFORGE_API_KEY`, then add the workflow:

```yaml
# .github/workflows/bcforge.yml
name: BCForge Check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  bcforge:
    name: BCForge – ID Ranges & Rules
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: BCForge Check
        uses: bcforge/bcforge-action@v1
        with:
          api-key: ${{ secrets.BCFORGE_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | **yes** | — | A BCForge CI key (`scope=ci`). Store as a repository secret. |
| `org` | no | from `.bcforge.json` | BCForge organisation UUID. Only needed to override the config file. |
| `workspace` | no | from `.bcforge.json` | BCForge workspace UUID. Only needed to override the config file. |
| `server-url` | no | `https://bcforge.net` | Override if you are self-hosting BCForge. |
| `fail-on-violations` | no | `true` | Set to `false` to report results without failing the workflow. |

## Outputs

| Output | Description |
|---|---|
| `status` | Overall result: `success`, `warning`, `failure`, or `skipped`. |
| `rule-violations` | Number of rule violations at failure severity. |
| `range-conflicts` | Number of ID range conflicts and out-of-pool IDs combined. |

## Using outputs

```yaml
- name: BCForge Check
  id: bcforge
  uses: bcforge/bcforge-action@v1
  with:
    api-key: ${{ secrets.BCFORGE_API_KEY }}
    fail-on-violations: 'false'   # don't block the build, just report

- name: Print result
  run: echo "BCForge status: ${{ steps.bcforge.outputs.status }}"
```

## Checks

Rules are configured per workspace in the BCForge web app. The action runs whatever rules are enabled for your workspace at the time of the check.

| Rule ID | Name | Default severity |
|---|---|---|
| BCF001 | Todo Comment | warning |
| BCF002 | Obsolete Tag | warning |
| BCF003 | Missing Caption | info |
| BCF010 | Large Function | warning |

Additional rules can be enabled and tuned from the BCForge workspace settings.

## CI source selector

If you use the BCForge GitHub Action, you can disable the BCForge GitHub App from posting its own check-run on the same PR to avoid duplicate results. Go to **Workspace Settings → GitHub Integration → CI check source** and select **GitHub Action only**.

| Setting | Behaviour |
|---|---|
| Both (default) | GitHub App webhook check runs and GitHub Action both active |
| GitHub App only | Action results are recorded but the App drives PR checks |
| GitHub Action only | App webhook check runs are suppressed; Action is authoritative |

## Requirements

- `ubuntu-latest`, `windows-latest`, or `macos-latest` runner
- Node.js 20 (provided by the runner — no setup step needed)
- A BCForge account with at least one workspace

## License

Apache 2.0