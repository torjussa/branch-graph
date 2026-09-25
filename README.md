# branch-graph

**See where every commit is across your dev → test → prod branches, in all your repos at once.**

A live, multi-repo alternative to GitHub's network graph. It shows what's waiting to be promoted and what's missing upstream, and checks that merges follow your flow. It runs locally with your own git credentials: no tokens, no server, no dependencies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/torjussa/branch-graph/main/docs/screenshot-dark.png">
  <img alt="branch-graph showing three repos with development, test and main lanes, promotion status cards and merge lines between branches" src="https://raw.githubusercontent.com/torjussa/branch-graph/main/docs/screenshot-light.png">
</picture>

## Why

If you promote code through long-lived environment branches (`development → test → main`, GitFlow, release branches), you keep asking:

- What's in `test` that isn't in production yet?
- Did that PR reach `test`? Is `main` behind?
- Was a hotfix made on `main` and never merged back?
- Did someone squash-merge a promotion, so the branches now disagree?

GitHub's network graph covers one repo at a time, is cached for hours and shows every feature branch. `branch-graph` covers all your repos on one timeline, shows only the branches you care about, and is up to date whenever you fetch.

## Quick start

Requires [Node.js](https://nodejs.org) 22+ and git.

```bash
npx branch-graph demo   # try it on generated example repos
npx branch-graph        # set up your own repos, then open the graph
```

Setup asks for your repos, then their branches in promotion order:

- **Repos:** pick from your GitHub orgs (if the [`gh`](https://cli.github.com) CLI is installed and logged in), from git clones in the current folder, or type a URL or `org/repo`.
- **Branches:** the first defaults to the repo's default branch, and the next ones are suggested (`test`, then `main` or `master`).

When you're done, the graph opens in your browser at `http://localhost:4321`. Next time, run `npx branch-graph <name>`.

Prefer to install it? Run `npm install -g branch-graph` and use `branch-graph`. From source: `git clone https://github.com/torjussa/branch-graph && cd branch-graph && node bin/branch-graph.mjs`.

## What you see

- **Status cards**, one per repo and one row per branch pair:
  - commits and changed files waiting to be promoted, or *In sync*
  - commits on the downstream branch that are missing upstream
  - fast-forwards, where a branch moved without a merge commit
- **The graph**, with one lane per branch and all repos on one timeline, so a vertical line is the same moment everywhere:
  - A hollow dot is a commit that hasn't reached the next branch yet.
  - Hover a merge to see and highlight the commits it brought in. Click any commit to open it on GitHub.
- **Flow checks** (optional) flag commits that break your branch flow, e.g. a squash merge on `test` or a hotfix straight to `main`.
- **Settings** (cog button) edits the config: repos, branches and their order, flow rules and period. Saving takes effect without a restart.

Data updates when you start the tool and when you press **Fetch**. There is no background polling.

## Commands

```bash
branch-graph [config]            # fetch and open the graph
branch-graph status [config]     # print promotion status; --json for scripts and agents
branch-graph init                # set up a config step by step
branch-graph init --name Acme --repo acme/api --repo acme/web   # set up without prompts
branch-graph demo                # try it on generated example repos
branch-graph install-skill       # install the agent skill
```

Run `branch-graph --help` for all options.

## Config

Configs are saved in `~/.config/branch-graph/` (`%APPDATA%\branch-graph\` on Windows), one JSON file per project. They're easiest to edit through **Settings** in the page:

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

- **`url` or `path`:** a config with `url` works on any machine, so you can share it. With `path`, it reuses a clone you already have; `branch-graph` only runs `git fetch` there and never touches your working tree or local branches.
- **Optional repo fields:** `remote` (default `origin`) and `webUrl` (for links, when it can't be worked out from the remote).
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

Back-merges from a later branch (e.g. `test` into `development`) are never flagged. Flow checks are hidden in the page by default. Turn them on with **Flow checks** in the header.

## For agents and scripts

`branch-graph status --json` prints the promotion status for every repo: pending commits, commits missing upstream, code diff, fast-forwards and flow issues, plus compare links. Progress messages go to stderr, so stdout is clean JSON.

```bash
branch-graph status acme --json --no-fetch | jq '.repos[].pairs[] | {from, to, state, pending: .pending.count}'
```

For AI coding agents there's a skill that teaches them when and how to use it. For [Claude Code](https://claude.com/claude-code):

```bash
npx branch-graph install-skill                           # installs into ~/.claude/skills
npx branch-graph install-skill --dir .claude/skills      # or into the current project
```

Other agents can read [`skills/branch-graph/SKILL.md`](skills/branch-graph/SKILL.md) directly. It also documents the JSON fields.

## Troubleshooting

- **"Could not read …" or a fetch fails:** `branch-graph` uses your normal git login. Check that `git ls-remote <url>` works in a terminal. For private repos, make sure HTTPS credentials (e.g. `gh auth login`) or an SSH key are set up. It never asks for a password itself.
- **No GitHub orgs in setup:** install the [`gh`](https://cli.github.com) CLI and run `gh auth login`, or type the repo instead.
- **Links go to the wrong place:** commit and compare links follow GitHub's URL format. For GitLab, Bitbucket or others, set `webUrl` in the config; links may still not match those sites' formats.
- **Port in use:** the next free port is picked automatically, or set one with `--port`.

## How it works

For each branch, `branch-graph` follows its first-parent history. A commit sits on the first lane, in promotion order, whose history contains it. Merges are drawn from the lane their second parent sits on. "Pending" is `git log to..from`, and the code diff is `git diff to from`, so a squash promotion shows up as *Same code*, not as missing work.

Everything runs on your machine. The page is served on `127.0.0.1` only and rejects requests from other sites. The only network traffic is `git fetch` or `git clone` to your own remotes, plus `gh` to list repos during setup.

## Contributing

Issues and pull requests are welcome. Run `npm test`; it needs no network. See [AGENTS.md](AGENTS.md) for the code map and conventions.

## License

[MIT](LICENSE)
