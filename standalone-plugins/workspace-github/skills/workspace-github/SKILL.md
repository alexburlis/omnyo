---
name: workspace-github
description: Browse and refresh GitHub repositories, issues and PRs discovered from Omnyo project sources, including nested checkouts.
---

Use `omnyo workspace-github repos --json`, `sync --json`, `issues [owner/repo] --json` and `prs [owner/repo] --json`. The cache holds only issues and PRs the signed-in GitHub account opened, plus bot PRs such as Dependabot on repositories where it has write access; other people's items never appear. Issue/PR CLI listings show cached open items. The GitHub panel is one Launchpad list of issues and PRs grouped by next action (Ready to merge, Blocked, Requires follow-up, Needs your review, Waiting, Checking with GitHub, Drafts, Open issues); Recently closed is a separate view. Cached rows and `prs --json` include `headRef`, `baseRef`, `additions`, `deletions`, `changedFiles`, `checks` (`success`, `failure` or `pending`), `reviewers`, `comments`, `labelColors`, `linkedIssues`, `createdAt`, `closedAt` and `mergedAt` when GitHub supplied them; rows synced before a field existed omit it until the next sync. `omnyo plugin rpc call workspace-github status --json` reports warnings.

The navigation icon shows the combined cached open PR and issue count across included repositories. Hover for separate totals; a dashed badge marks counts that may be out of date and `—` marks unavailable or unsynced counts. Panel filters do not change the icon count.

Do not treat a failed or incomplete sync as zero live items. Check warnings, source-machine connectivity and existing GitHub CLI authentication. `extraRepos` adds explicit owner/repo pairs, separated by commas or new lines. Settings → Plugins → GitHub lists current repositories with searchable All / Included / Excluded filters and immediate inclusion switches. Exclusions hide cached rows and stop tracking those repos across the panel, CLI and mention search; including them restores cached rows. Use `printf '%s' '{}' | omnyo plugin rpc call workspace-github repositorySettings --input-file /dev/stdin --json` to inspect the catalog, or `printf '%s' '{"repo":"owner/repo","excluded":true}' | omnyo plugin rpc call workspace-github setRepoExcluded --input-file /dev/stdin --json` to exclude (`false` to include). Refreshing the settings list discovers current sources without syncing GitHub. The panel's repository rail scopes the list to one or more repositories and remembers the selection in the browser; `defaultProject` handles agent handoffs only for repositories without an attached project. GitHub writes or spawning an agent require the user's request.

## Close and merge

Issue details and pull request details show Close or Reopen when the signed-in GitHub account has permission. Pull request details also offer the repository's enabled merge methods, with an explicit confirmation. Read-only repositories explain why these actions are unavailable. GitHub reviews, checks, conflicts, and branch rules still apply; Omnyo does not request an administrator override, enable auto-merge, enqueue a merge, or delete a branch.

The same actions are available through the plugin RPC SDK and `omnyo plugin rpc call workspace-github METHOD --input-file FILE --json`:

| Method          | JSON input                                                                                |
| --------------- | ----------------------------------------------------------------------------------------- |
| `itemActions`   | `{"kind":"pr","repo":"owner/repo","number":7}` (`kind` can also be `issue`)               |
| `setIssueState` | `{"repo":"owner/repo","number":7,"state":"closed"}`                                       |
| `setPullState`  | `{"repo":"owner/repo","number":7,"state":"closed"}`                                       |
| `mergePull`     | `{"repo":"owner/repo","number":7,"method":"squash","headOid":"FULL_REVIEWED_COMMIT_SHA"}` |

The panel's Merge all on Ready to merge is the same two calls per pull request (`itemActions`, then `mergePull` with that `headOid`), run one at a time after one confirmation; an agent repeats them per pull request only at the user's request. Saved views live in the browser and have no CLI. Use `state: "open"` to reopen. Read `itemActions` before merging; use its `headOid` and an enabled `mergeMethods` value (`squash`, `merge`, or `rebase`). The server checks permissions and merge requirements again, and GitHub atomically rejects a changed head commit. A false or failed merge response never marks the cache as merged. These write methods require the user's action; providing a JSON file does not authorize an agent to close or merge an item.
