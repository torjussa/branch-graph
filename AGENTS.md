# AGENTS.md

`branch-graph` is a zero-dependency Node CLI plus a local web page that shows how long-lived branches (development → test → main) relate across several git repos. User docs: [README.md](README.md). Commands: `package.json` scripts and `node bin/branch-graph.mjs --help`.

## Map

| Path | Role |
|---|---|
| `bin/branch-graph.mjs` | CLI: argument parsing and commands (`serve`, `status`, `init`, `demo`, `install-skill`) |
| `src/config.mjs` | Config folder, validation (`parseConfig`), file format (`formatConfig`) |
| `src/git.mjs` | The only place that spawns git |
| `src/repo-data.mjs` | Branch chains, promotion status and flow checks for one repo |
| `src/status.mjs` | `status` output (JSON and text) built from `repo-data` |
| `src/server.mjs` | HTTP API and static files for the page |
| `src/setup.mjs` | Interactive and non-interactive `init`, repo lookup, branch suggestions |
| `src/demo.mjs` | Fake repos, used by `demo` and by the test fixture |
| `public/` | The page: plain ES modules, no build step (`lib.js` holds DOM helpers) |
| `skills/branch-graph/SKILL.md` | Agent skill shipped with the package |
| `test/` | `node:test` suites; `fixture.mjs` builds a throwaway repo covering every flow case |

## Rules

- **Zero dependencies.** Node ≥ 22 built-ins only, no bundler. The page loads as-is from `public/`.
- **Every git argument is validated.** Branch and remote names go through `isSafeRef`, and URLs must match `URL_PATTERN`. git runs through `execFile`, never a shell, so a name like `--upload-pack=…` can't become an option.
- **Page text goes in text nodes.** Build DOM with `h()` / `s()` from `public/lib.js`. Commit messages and branch names are untrusted.
- **The server is local only:** it binds to `127.0.0.1` and checks `Host`/`Origin` on every request. Keep that for new endpoints.
- **`status --json` is a public contract.** Agents and scripts parse it. Add fields freely; to rename or remove one, also update `skills/branch-graph/SKILL.md` and the README.
- **The repo holds no real data.** Configs live in the user's config folder (`CONFIG_DIR`), never in the repo. Examples use the fake `acme` org, and screenshots come from `npm run demo`.

## Testing

`npm test` runs every suite against fixture repos in a temp folder: no network, no config folder touched (`BRANCH_GRAPH_CONFIG_DIR` / `BRANCH_GRAPH_CACHE_DIR` point elsewhere). A change is done when `npm test` is green and, for page changes, `npm run demo` shows it working in a browser.
