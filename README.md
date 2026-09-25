# branch-graph

Shows how long-lived branches (such as `development` → `test` → `main`) relate across several git repos: which commits are waiting to be promoted, which are missing upstream, and whether merges follow your branch flow. It runs locally and uses your existing git credentials.

GitHub's network graph shows one repo at a time, is cached for hours and includes every feature branch. branch-graph puts several repos on one timeline, shows only the branches you configure, and is as current as your last fetch.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/torjussa/branch-graph/main/docs/screenshot-dark.png">
  <img alt="branch-graph showing three repos with development, test and main lanes, promotion status cards and merge lines between branches" src="https://raw.githubusercontent.com/torjussa/branch-graph/main/docs/screenshot-light.png">
</picture>

## Quick start

Requires [Node.js](https://nodejs.org) 22+ and git.

```bash
npx branch-graph demo   # try it on generated example repos
npx branch-graph        # set up your repos and open the graph
```

Setup asks for your repos, then their branches in promotion order:

- **Repos:** pick from your GitHub orgs (needs the [`gh`](https://cli.github.com) CLI, logged in), from git clones in the current folder, or type a URL or `org/repo`.
- **Branches:** the first defaults to the repo's default branch, and the next ones are suggested (`test`, then `main` or `master`).

The graph then opens at `http://localhost:4321`. After that, `npx branch-graph` opens the config you used last. Pass a name to open another one, or run `npx branch-graph init` to add one.

Install globally with `npm install -g branch-graph`, or run from source: `git clone https://github.com/torjussa/branch-graph && cd branch-graph && node bin/branch-graph.mjs`.

## What you see

- **Status cards**, one per repo, with a row per branch pair:
  - commits and changed files waiting to be promoted, or *In sync*
  - commits on the downstream branch that are missing upstream
  - fast-forwards, where a branch moved without a merge commit
- **The graph**: one lane per branch, with all repos on the same time axis.
  - A hollow dot is a commit that hasn't reached the next branch yet.
  - Hover a merge to highlight the commits it brought in. Click a commit to open it on GitHub.
- **Flow checks** (optional) flag commits that break your branch flow, e.g. a squash merge on `test` or a hotfix straight to `main`.
- **Settings** (cog button) edits the config: repos, branch order, flow rules and period. Changes apply without a restart. The theme (System, Light or Dark) is also set here and stored in the browser, not the config.

Data is fetched on start and when you press **Fetch**.

## Commands

```bash
branch-graph [config]            # fetch and open the graph (default: the config used last)
branch-graph status [config]     # print promotion status; --json for scripts and agents
branch-graph init                # set up a config step by step
branch-graph init --name Acme --repo acme/api --repo acme/web   # set up without prompts
branch-graph demo                # try it on generated example repos
branch-graph install-skill       # install the agent skill
```

Run `branch-graph --help` for all options.

## Config

Configs are saved in `~/.config/branch-graph/` (`%APPDATA%\branch-graph\` on Windows), one JSON file per project. Edit them in the page (**Settings**) or by hand:

```jsonc
{
  "name": "Acme",
  "days": 60,                                            // how far back to look
  "flow": { "integration": "squash", "promotion": "merge" },  // or false
  "repos": [
    {
      "name": "api",
      "url": "https://github.com/acme/api.git",          // cloned into ~/.cache/branch-graph
      "branches": ["development", "test", "main"]        // promotion order, first = where features land
    },
    {
      "name": "web",
      "path": "~/code/acme-web",                         // or an existing local clone
      "branches": ["develop", "main"]
    }
  ]
}
```

- **`url` or `path`:** a config with `url` works on any machine. With `path` it uses an existing clone, where branch-graph only runs `git fetch` and doesn't touch the working tree or local branches.
- **Optional repo fields:** `remote` (default `origin`) and `webUrl` (for links, when it can't be derived from the remote).
- **`BRANCH_GRAPH_CONFIG_DIR`** and **`BRANCH_GRAPH_CACHE_DIR`** override the folders.

### Flow checks

The first branch is the *integration* branch, where features land. The rest are *promotion* branches.

| Setting | Flags |
|---|---|
| `integration: "squash"` | Merge commits and commits without a PR number on the integration branch (warning) |
| `integration: "merge"` | Direct commits on the integration branch (warning) |
| `promotion: "merge"` | Squash or direct commits on a promotion branch, and merges from anything but the branch before it (error) |
| `promotion: "squash"` | Merge commits on a promotion branch (error) |
| `"any"` | Nothing |

Back-merges from a later branch (e.g. `test` into `development`) are never flagged. Flow checks are hidden in the page by default; turn them on with **Flow checks** in the header.

## For agents and scripts

`branch-graph status --json` prints the status of every repo: pending commits, commits missing upstream, code diff, fast-forwards, flow issues and compare links. Progress messages go to stderr, so stdout is clean JSON.

```bash
branch-graph status acme --json --no-fetch | jq '.repos[].pairs[] | {from, to, state, pending: .pending.count}'
```

An agent skill describes when and how to use it. For [Claude Code](https://claude.com/claude-code):

```bash
npx branch-graph install-skill                           # installs into ~/.claude/skills
npx branch-graph install-skill --dir .claude/skills      # or into the current project
```

Other agents can read [`skills/branch-graph/SKILL.md`](skills/branch-graph/SKILL.md) directly. It also documents the JSON fields.

## Troubleshooting

- **"Could not read …" or a fetch fails:** branch-graph uses your normal git login. Check that `git ls-remote <url>` works in a terminal. For private repos, set up HTTPS credentials (e.g. `gh auth login`) or an SSH key. branch-graph never asks for a password.
- **No GitHub orgs in setup:** install the [`gh`](https://cli.github.com) CLI and run `gh auth login`, or type the repo instead.
- **Links go to the wrong place:** commit and compare links use GitHub's URL format. For GitLab, Bitbucket or others, set `webUrl` in the config; links may still not match those sites' formats.
- **Port in use:** the next free port is used, or set one with `--port`.

## How it works

For each branch, branch-graph follows its first-parent history. A commit is drawn on the first lane, in promotion order, whose history contains it, and a merge is drawn from the lane of its second parent. "Pending" is `git log to..from` and the code diff is `git diff to from`, so a squash promotion shows up as *Same code*, not as missing work.

The page is served on `127.0.0.1` only and rejects requests from other sites. The only network traffic is `git fetch` or `git clone` to your own remotes, and `gh` to list repos during setup.

## Contributing

Issues and pull requests are welcome. `npm test` runs without network access. See [AGENTS.md](AGENTS.md) for the code map and conventions.

## License

[MIT](LICENSE)
