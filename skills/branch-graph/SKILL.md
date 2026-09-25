---
name: branch-graph
description: Promotion status of long-lived branches (development → test → main) across one or more git repos, via the branch-graph CLI. Use when asked what is waiting to be promoted or released, whether environment branches are in sync, whether a commit or PR has reached test or production, or about flow slips such as squash merges or hotfixes on promotion branches.
---

# branch-graph

`branch-graph` reads git history for a set of repos and, for each repo, compares each branch with the next one in its pipeline (e.g. `development → test`, `test → main`). It only runs `git fetch` and read-only git commands.

Run it as `npx -y branch-graph` (or `branch-graph` if installed globally).

## Steps

1. **Pick a config.** Configs live in the user's config folder (`~/.config/branch-graph/`, `%APPDATA%\branch-graph\` on Windows). Run `npx -y branch-graph status` with no name: it prints the available names if there are several, or `No config yet` if there are none. Done when you have a config name, or have created one:
   ```bash
   npx -y branch-graph init --name "<project>" --repo <org/repo> --repo <org/repo2>
   ```
   Each `--repo` is a GitHub URL, `org/repo` or local folder. Branches are detected (default branch plus `test`, `main`, …). To set them: `--repo org/repo=development,test,main`. Confirm the repo list with the user before creating a config.

2. **Get the status.**
   ```bash
   npx -y branch-graph status <config> --json
   ```
   This fetches first. Add `--no-fetch` to reuse the last fetch, or `--days <n>` to change how far back flow checks look. Done when the output parses as JSON and no repo has an `error` or `fetchError` (report those to the user if they persist).

3. **Answer from the JSON**, repo by repo and pair by pair (reference below). Quote commit subjects and short SHAs, and give `compareUrl` for any pair with pending work.

For a visual graph, suggest the user run `npx branch-graph <config>`: it opens a local page with the network graph and a settings dialog.

## JSON reference

```jsonc
{
  "project": "Acme", "days": 60, "fetchedAt": "…", "flowChecks": { "integration": "squash", "promotion": "merge" } /* or false */,
  "repos": [{
    "name": "api", "webUrl": "https://github.com/acme/api",
    "error": "…", "fetchError": "…", "missingBranches": ["…"],   // only when something is wrong
    "branches": { "development": { "sha", "subject", "date" }, … },  // tip of each pipeline branch
    "pairs": [{
      "from": "development", "to": "test",
      "state": "pending",          // in-sync | same-code | pending | diverged
      "pending": { "count": 2, "capped": false, "commits": [{ "sha", "subject", "author", "date" }] },
      "missingUpstream": { "count": 0, "commits": [] },
      "diff": { "files": 3, "ins": 40, "del": 12 },   // null when the code is identical
      "fastForward": false,
      "compareUrl": "https://github.com/acme/api/compare/test...development"
    }],
    "flowIssues": [{ "level": "error", "message": "…", "branch": "main", "sha", "subject", "author", "date" }]
  }]
}
```

- **state**: `in-sync` means nothing differs. `same-code` means the commits differ but the code is identical (e.g. after a squash). `pending` means `from` has commits to promote. `diverged` means nothing to promote, but `to` has changes `from` lacks.
- **pending**: commits in `from` that `to` lacks, newest first. This is "what the next promotion will carry". `capped` means there are more than listed.
- **missingUpstream**: commits on `to` that `from` lacks, typically hotfixes or squash promotions that were never merged back. Worth flagging.
- **fastForward**: `to` was moved onto `from`'s history without a merge commit.
- **flowIssues**: commits in the period that break the configured flow (`flowChecks`). `error` is for promotion branches (squash or direct commits, merges from the wrong branch). `warn` is for the first branch (merge commits, commits without a PR). The list is empty when `flowChecks` is `false`.
