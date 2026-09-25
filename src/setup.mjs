import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, ROOT, URL_PATTERN, expandHome, formatConfig, isSafeRef, loadConfig, tilde } from './config.mjs';
import { git } from './git.mjs';

/** Likely pipeline stages, upstream first. Used to suggest the next branch. */
const STAGES = [
  ['develop', 'development', 'dev'],
  ['test', 'testing', 'qa', 'stage', 'staging', 'uat', 'preprod'],
  ['main', 'master', 'prod', 'production'],
];
const DEFAULT_FLOW = { integration: 'squash', promotion: 'merge' };
const LIST_SIZE = 15;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');

function prompter() {
  if (!process.stdin.isTTY) throw new Error('Setup needs an interactive terminal. Use: branch-graph init --name <name> --repo <org/repo> (see --help).');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\nSetup cancelled.\n');
    process.exit(130);
  });
  const ask = async (question, fallback) => {
    const answer = (await rl.question(fallback ? `${question} ${dim(`[${fallback}]`)}: ` : `${question}: `)).trim();
    return answer || fallback || '';
  };
  const confirm = async (question, yes = true) => {
    const answer = (await rl.question(`${question} ${dim(yes ? '[Y/n]' : '[y/N]')}: `)).trim().toLowerCase();
    return answer ? answer.startsWith('y') : yes;
  };
  return { ask, confirm, close: () => rl.close() };
}

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Repo name from a URL or path (also Windows paths), reduced to characters a repo name allows. */
const baseName = (url) => url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/, '').replace(/[^\w.-]+/g, '-');
const stageOf = (branch) => STAGES.findIndex((group) => group.includes(branch));

/** Default branch and branch list of a remote, without cloning. */
async function lsRemote(cwd, target) {
  let sym;
  let heads;
  try {
    [sym, heads] = await Promise.all([
      git(cwd, ['ls-remote', '--symref', target, 'HEAD']),
      git(cwd, ['ls-remote', '--heads', target]),
    ]);
  } catch {
    throw new Error(`Could not read ${target}. Check the address and that git can reach it (try: git ls-remote ${target}).`);
  }
  const branches = heads.split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref) => ref?.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .filter(isSafeRef);
  if (!branches.length) throw new Error(`No branches found in ${target}.`);
  const head = sym.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
  return { head: branches.includes(head) ? head : null, branches };
}

/** Resolve what the user typed to a URL or local clone, and read its branches. */
export async function inspect(input) {
  const local = path.resolve(expandHome(input));
  if (existsSync(local)) {
    try { await git(local, ['rev-parse', '--git-dir']); } catch { throw new Error(`Not a git repo: ${local}`); }
    const remotes = (await git(local, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw new Error(`${local} has no remote.`);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const remoteUrl = (await git(local, ['remote', 'get-url', remote])).trim();
    return { source: { path: tilde(local), ...(remote !== 'origin' && { remote }) }, name: baseName(remoteUrl) || path.basename(local), ...(await lsRemote(local, remote)) };
  }

  let url = input;
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) url = `https://github.com/${input.replace(/\.git$/, '')}.git`;
  else if (!URL_PATTERN.test(input)) throw new Error('Not a URL, org/repo or existing folder.');
  return { source: { url }, name: baseName(url), ...(await lsRemote(process.cwd(), url)) };
}

/* ---------- Repo sources ---------- */

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout)));
  });
}

function ago(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.round(sec / 86400)}d ago`;
  if (sec < 86400 * 365) return `${Math.round(sec / 2592000)}mo ago`;
  return `${Math.round(sec / 31536000)}y ago`;
}

const isUrl = (input) => URL_PATTERN.test(input);
const keyOf = (input) => (isUrl(input) ? input.toLowerCase() : path.resolve(expandHome(input)));
const isAdded = (repos, input) => repos.some((r) => keyOf(r.url ?? r.path) === keyOf(input));

/** Places to pick repos from: GitHub orgs and account via the gh CLI, and git clones in the current folder. */
export async function findSources() {
  const sources = [];
  try {
    const [login, orgs] = await Promise.all([
      run('gh', ['api', 'user', '-q', '.login']),
      run('gh', ['api', 'user/orgs', '--paginate', '-q', '.[].login']),
    ]);
    for (const owner of [...orgs.split('\n'), login].map((o) => o.trim()).filter(Boolean)) {
      sources.push({ label: `GitHub: ${owner}`, load: () => githubRepos(owner) });
    }
  } catch { /* gh missing or not logged in */ }

  const clones = await localClones(process.cwd());
  if (clones.length) sources.push({ label: `Clones in ${tilde(process.cwd())}`, load: async () => clones });
  return sources;
}

async function githubRepos(owner) {
  const out = await run('gh', ['repo', 'list', owner, '--limit', '1000', '--no-archived', '--json', 'name,url,pushedAt']);
  return JSON.parse(out)
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .map((r) => ({ label: r.name, hint: `pushed ${ago(r.pushedAt)}`, input: `${r.url}.git`, value: `${owner}/${r.name}` }));
}

async function localClones(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = [dir, ...entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name))];
  const clones = [];
  for (const d of dirs.filter((x) => x !== ROOT && existsSync(path.join(x, '.git')))) {
    const remote = await git(d, ['remote', 'get-url', 'origin']).then((u) => u.trim()).catch(() => '');
    clones.push({ label: path.basename(d), hint: remote.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') || 'no origin', input: d, value: tilde(d) });
  }
  return clones;
}

function parseNumbers(text) {
  const out = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const [a, b] = [+m[1], +(m[2] ?? m[1])];
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n);
  }
  return [...new Set(out)];
}

/** Numbered list, most recent first, with a text filter. Returns the picked items, or [] to go back. */
async function pickFromList(io, title, items, repos) {
  let filter = '';
  for (;;) {
    const shown = items.filter((it) => it.label.toLowerCase().includes(filter.toLowerCase()));
    const page = shown.slice(0, LIST_SIZE);
    console.log(`\n${bold(title)}${filter ? ` matching "${filter}"` : ''} ${dim(`(${plural(shown.length, 'repo', 'repos')})`)}`);
    const width = Math.max(0, ...page.map((it) => it.label.length));
    page.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}) ${it.label.padEnd(width)}  ${isAdded(repos, it.input) ? green('added') : dim(it.hint)}`));
    if (shown.length > LIST_SIZE) console.log(dim(`      … ${shown.length - LIST_SIZE} more. Type text to filter.`));

    const answer = await io.ask(`Pick numbers (e.g. 1 3 or 1-3), text to filter${filter ? ', * for all' : ''}, Enter to go back`);
    if (!answer) return [];
    if (answer === '*') { filter = ''; continue; }
    if (!/^[\d\s,-]+$/.test(answer)) { filter = answer; continue; }
    const picked = parseNumbers(answer);
    if (!picked || picked.some((n) => n < 1 || n > page.length)) {
      console.log(red(`  Pick numbers from 1 to ${page.length}.`));
      continue;
    }
    return picked.map((n) => page[n - 1]).filter((it) => !isAdded(repos, it.input));
  }
}

/** Ask where to find repos until the user picks some. Returns picks ({ input, label }), or null when done. */
async function askRepos(io, sources, repos) {
  for (;;) {
    const hasRepos = repos.length > 0;
    let source = 'type';
    if (sources.length) {
      console.log(`\n${bold(hasRepos ? 'Add more repos' : 'Where are the repos?')}`);
      sources.forEach((src, i) => console.log(`  ${i + 1}) ${src.label}`));
      console.log(`  ${sources.length + 1}) Type a URL, org/repo or folder`);
      const answer = await io.ask(hasRepos ? `Choose ${dim('(Enter to finish)')}` : 'Choose', hasRepos ? undefined : '1');
      if (!answer) return null;
      const n = Number(answer);
      if (!Number.isInteger(n) || n < 1 || n > sources.length + 1) {
        console.log(red(`  Pick 1 to ${sources.length + 1}.`));
        continue;
      }
      source = sources[n - 1] ?? 'type';
    }

    if (source === 'type') {
      const hint = sources.length ? ' (Enter to go back)' : hasRepos ? ' (Enter to finish)' : '';
      const input = await io.ask(`\n${bold('Repo')}: GitHub URL, org/repo or local folder${dim(hint)}`);
      if (input) return [{ input, label: null }];
      if (!sources.length && hasRepos) return null;
      if (!sources.length) console.log(red('  Add at least one repo.'));
      continue;
    }

    process.stdout.write(dim('  Listing repos…'));
    try {
      source.items ??= await source.load();
    } catch (err) {
      console.log(`\r\x1b[2K${red(`  Could not list repos: ${err.message}`)}`);
      continue;
    }
    process.stdout.write('\r\x1b[2K');
    const picks = await pickFromList(io, source.label, source.items, repos);
    if (picks.length) return picks;
  }
}

/** Names without the prefix picked repos share: acme-api, acme-web -> api, web. */
function suggestNames(labels) {
  const known = labels.filter(Boolean);
  let prefix = '';
  if (known.length > 1) {
    prefix = known.reduce((p, l) => {
      let i = 0;
      while (i < p.length && p[i] === l[i]) i++;
      return p.slice(0, i);
    });
    prefix = prefix.slice(0, Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.')) + 1);
  }
  return labels.map((l) => (l && l.length > prefix.length ? l.slice(prefix.length) : null));
}

/** Read one repo's branches and ask for its name and pipeline. Returns null if it can't be used. */
async function configureRepo(io, pick, suggestedName, repos) {
  console.log(`\n${bold(pick.label ?? pick.input)}`);
  process.stdout.write(dim('  Reading branches…'));
  let found;
  try {
    found = await inspect(pick.input);
  } catch (err) {
    console.log(`\r\x1b[2K${red(`  ${err.message}`)}`);
    return null;
  }
  process.stdout.write('\r\x1b[2K');
  if (isAdded(repos, found.source.url ?? found.source.path)) {
    console.log(red('  Already added.'));
    return null;
  }
  console.log(`  ${plural(found.branches.length, 'branch', 'branches')}, default ${found.head ? bold(found.head) : dim('unknown')}`);

  const name = await askName(io, suggestedName ?? found.name, repos);
  const branches = await askBranches(io, found);
  console.log(green(`  ✓ ${name}: ${branches.join(' → ')}`));
  return { name, ...found.source, branches };
}

async function askName(io, suggested, repos) {
  for (;;) {
    const name = await io.ask('  Name', suggested);
    if (!/^[\w.-]+$/.test(name)) console.log(red('  Use letters, digits, ".", "_" or "-".'));
    else if (repos.some((r) => r.name === name)) console.log(red(`  "${name}" is already used.`));
    else return name;
  }
}

async function askBranch(io, label, suggested, found, chosen) {
  for (;;) {
    const branch = await io.ask(label, suggested);
    if (!branch || branch === '-') return null;
    if (chosen.includes(branch)) {
      console.log(red(`  ${branch} is already in the list.`));
      continue;
    }
    if (found.branches.includes(branch)) return branch;
    const similar = found.branches.filter((b) => b.toLowerCase().includes(branch.toLowerCase())).slice(0, 6);
    console.log(red(`  No branch "${branch}" on the remote.`) + (similar.length ? dim(` Similar: ${similar.join(', ')}`) : ''));
  }
}

/** The next likely pipeline stage after the chosen branches, if the repo has one. */
function nextStage(chosen, branches) {
  const stage = Math.max(...chosen.map(stageOf));
  return STAGES.flat().find((b) => stageOf(b) > stage && branches.includes(b) && !chosen.includes(b));
}

/** Default branch followed by the likely stages, e.g. development → test → main. */
export function suggestPipeline(head, branches) {
  const out = head ? [head] : [];
  for (let next = out.length && nextStage(out, branches); next; next = nextStage(out, branches)) out.push(next);
  return out;
}

/** First branch defaults to the remote default; each next one suggests the next likely stage. */
async function askBranches(io, found) {
  const chosen = [];
  let first = null;
  while (!first) {
    first = await askBranch(io, '  First branch (where features land)', found.head, found, chosen);
    if (!first) console.log(red('  A first branch is required.'));
  }
  chosen.push(first);
  console.log(dim('  Now the branches it is promoted to, in order. Enter accepts the suggestion, "-" stops.'));

  for (;;) {
    const last = chosen.at(-1);
    const suggestion = nextStage(chosen, found.branches);
    const next = await askBranch(io, `  After ${last}${suggestion ? '' : dim(' (Enter to finish)')}`, suggestion, found, chosen);
    if (!next) return chosen;
    chosen.push(next);
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Interactive setup. Returns the saved config file and whether to start the graph now. */
export async function runSetup() {
  const io = prompter();
  try {
    console.log(`${bold('branch-graph setup')}\n${dim(`Creates a config in ${tilde(CONFIG_DIR)}. Change it later in the page (cog button) or by hand.`)}\n`);

    let name = '';
    while (!slugify(name)) name = await io.ask('Project name');

    process.stdout.write(dim('Looking for repos…'));
    const sources = await findSources();
    process.stdout.write('\r\x1b[2K');

    const repos = [];
    for (;;) {
      const picks = await askRepos(io, sources, repos);
      if (!picks) break;
      const names = suggestNames(picks.map((p) => p.label));
      for (const [i, pick] of picks.entries()) {
        const repo = await configureRepo(io, pick, names[i], repos);
        if (repo) repos.push(repo);
      }
    }

    // Local folders only exist on this machine; the .local suffix marks such configs.
    const local = repos.some((r) => r.path);
    const fileFor = (slug) => path.join(CONFIG_DIR, `${slug}${local ? '.local' : ''}.json`);
    let file = fileFor(slugify(name));
    while (existsSync(file) && !(await io.confirm(`\n${path.relative(process.cwd(), file)} exists. Overwrite?`, false))) {
      const other = await io.ask('Save under another name');
      if (slugify(other)) {
        name = other;
        file = fileFor(slugify(other));
      }
    }

    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(file, formatConfig({ name, days: 60, flow: DEFAULT_FLOW, repos }));
    await loadConfig(file);

    const configName = path.basename(file, '.json');
    console.log(`\n${green('✓')} Saved ${bold(tilde(file))}`);
    if (local) console.log(dim('  Uses local folders, so it only works on this machine.'));
    console.log(dim(`  Flow checks assume squash into the first branch and merges to the rest. Change "flow" in the file if not.`));
    console.log(`  Run it later with: ${bold(`branch-graph ${configName}`)}\n`);

    return { file, start: await io.confirm('Start now?') };
  } finally {
    io.close();
  }
}

/**
 * Setup without prompts, for scripts and agents.
 * Each spec is "<source>" (branches detected) or "<source>=<branch>,<branch>".
 */
export async function initFromArgs({ name, specs, flow, days = 60, force = false }) {
  if (!name || !slugify(name)) throw new Error('Pass a project name: --name <name>');
  if (!specs?.length) throw new Error('Pass at least one repo: --repo <org/repo>');

  const found = [];
  for (const spec of specs) {
    const eq = spec.lastIndexOf('=');
    const [source, list] = eq > 0 ? [spec.slice(0, eq), spec.slice(eq + 1)] : [spec, ''];
    const repo = await inspect(source).catch((err) => { throw new Error(`${source}: ${err.message}`); });
    const branches = list ? list.split(',').map((b) => b.trim()).filter(Boolean) : suggestPipeline(repo.head, repo.branches);
    if (!branches.length) throw new Error(`${source}: no default branch found. Name the branches: --repo ${source}=main`);
    const unknown = branches.filter((b) => !repo.branches.includes(b));
    if (unknown.length) throw new Error(`${source}: not on the remote: ${unknown.join(', ')}`);
    if (found.some((f) => keyOf(f.key) === keyOf(repo.source.url ?? repo.source.path))) throw new Error(`${source}: listed twice`);
    found.push({ ...repo, key: repo.source.url ?? repo.source.path, branches });
  }

  const names = suggestNames(found.map((f) => f.name));
  const repos = [];
  found.forEach((f, i) => {
    let repoName = names[i] ?? f.name;
    for (let n = 2; repos.some((r) => r.name === repoName); n++) repoName = `${names[i] ?? f.name}-${n}`;
    repos.push({ name: repoName, ...f.source, branches: f.branches });
  });

  const file = path.join(CONFIG_DIR, `${slugify(name)}${repos.some((r) => r.path) ? '.local' : ''}.json`);
  if (existsSync(file) && !force) throw new Error(`${tilde(file)} exists. Pass --force to overwrite it.`);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(file, formatConfig({ name, days, flow, repos }));
  await loadConfig(file);
  return { file, repos };
}
