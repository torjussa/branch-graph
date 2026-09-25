#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, ROOT, configNames, defaultConfig, expandHome, loadConfig, migrateOldConfigs, rememberConfig, resolveConfigPath, tilde } from '../src/config.mjs';
import { createDemo } from '../src/demo.mjs';
import { ensureRepo } from '../src/git.mjs';
import { fetchAll, startServer } from '../src/server.mjs';
import { initFromArgs, runSetup } from '../src/setup.mjs';
import { collectStatus, formatStatus } from '../src/status.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `branch-graph ${version}: promotion status and a graph for long-lived branches across several git repos.

Usage:
  branch-graph [config]              Fetch and open the graph in the browser
  branch-graph status [config]       Print promotion status (--json for scripts and agents)
  branch-graph init                  Set up a config step by step
  branch-graph init --name <name> --repo <repo> [--repo <repo>...]
                                     Set up a config without prompts
  branch-graph demo                  Try it on generated example repos
  branch-graph install-skill         Install the agent skill (Claude Code: ~/.claude/skills)

  config   Config name (saved in ${tilde(CONFIG_DIR)}) or path to a .json file.
           Without it: the config used last, or setup if there is none yet.
  repo     GitHub URL, org/repo or local folder. Branches default to the repo's default branch
           plus likely next stages (e.g. development → test → main).
           Set them yourself with org/repo=development,test,main

Options:
  --json               status: print JSON
  --days <n>           status: look back n days (default: from the config)
  --no-fetch           Skip git fetch and use the data from the last fetch
  --port <n>           Port for the page (default 4321, tries the next free one)
  --no-open            Do not open the browser
  --integration <m>    init: how features land in the first branch: squash (default), merge, any
  --promotion <m>      init: how later branches get changes: merge (default), squash, any
  --no-flow            init: turn flow checks off
  --force              init: overwrite an existing config
  --dir <folder>       install-skill: skills folder to install into
  -v, --version        Print the version
  -h, --help           Show this help`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      days: { type: 'string' },
      'no-fetch': { type: 'boolean', default: false },
      port: { type: 'string', default: '4321' },
      'no-open': { type: 'boolean', default: false },
      name: { type: 'string' },
      repo: { type: 'string', multiple: true },
      integration: { type: 'string' },
      promotion: { type: 'string' },
      'no-flow': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      dir: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\nRun branch-graph --help for usage.`);
  process.exit(1);
}
const opts = args.values;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (opts.version) {
  console.log(version);
  process.exit(0);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Config file to run: from the argument, the one used last, or created interactively. Null means exit. */
async function pickConfigFile(arg, { allowSetup }) {
  if (arg) return resolveConfigPath(arg);
  const names = await configNames();
  if (names.length === 0) {
    if (!allowSetup || !process.stdin.isTTY) fail('No config yet. Run: branch-graph init');
    console.log('No config yet. Starting setup.\n');
    const { file, start } = await runSetup();
    return start ? file : null;
  }
  if (names.length === 1) return resolveConfigPath(names[0]);
  // Scripts and agents name the config, so what they get doesn't depend on what ran last.
  if (!process.stdin.isTTY) fail(`Several configs, pass one: ${names.join(', ')}`);
  const { name, why } = await defaultConfig(names);
  const others = names.filter((n) => n !== name).join(', ');
  console.error(`Using ${name} (${why}). Others: ${others}. Pass a name to switch, or run init to add one.`);
  return resolveConfigPath(name);
}

async function prepare(file, log) {
  const config = await loadConfig(file);
  await rememberConfig(file);
  await Promise.all(config.repos.map((repo) => ensureRepo(repo)));
  const state = { fetchedAt: null, fetchErrors: {}, hosts: new Set() };
  if (!opts['no-fetch']) {
    log(`Fetching ${plural(config.repos.length, 'repo')}…`);
    state.fetchErrors = await fetchAll(config, log);
    state.fetchedAt = Date.now();
  }
  return { config, state };
}

async function serve(file) {
  const { config, state } = await prepare(file, console.log);
  const { port } = await startServer(config, { port: parseInt(opts.port, 10) || 4321, state });
  const url = `http://localhost:${port}`;
  console.log(`\n${config.name}: ${url}  (Ctrl+C to stop)`);

  if (!opts['no-open']) {
    const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open', url]
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url];
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
}

async function status(file) {
  let days;
  if (opts.days !== undefined) {
    days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1) fail('--days must be a positive whole number');
  }
  // Progress goes to stderr, and only for people, so stdout stays clean for --json.
  const log = process.stderr.isTTY ? (msg) => console.error(msg) : () => {};
  const { config, state } = await prepare(file, log);
  const result = await collectStatus(config, { days, fetchedAt: state.fetchedAt, fetchErrors: state.fetchErrors });
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else console.log(formatStatus(result, { color: process.stdout.isTTY && !process.env.NO_COLOR }));
}

async function init() {
  if (!opts.repo?.length) {
    if (opts.name) fail('Pass at least one repo: --repo <org/repo>');
    const { file, start } = await runSetup();
    await rememberConfig(file);
    if (start) await serve(file);
    return;
  }
  const flow = opts['no-flow'] ? false : { integration: opts.integration ?? 'squash', promotion: opts.promotion ?? 'merge' };
  const { file, repos } = await initFromArgs({ name: opts.name, specs: opts.repo, flow, force: opts.force });
  await rememberConfig(file);
  console.log(`Saved ${tilde(file)}`);
  for (const r of repos) console.log(`  ${r.name}: ${r.branches.join(' → ')}`);
  console.log(`Run: branch-graph ${file.split(/[\\/]/).pop().replace(/\.json$/, '')}`);
}

try {
  const moved = await migrateOldConfigs();
  if (moved.length) console.error(`Copied ${plural(moved.length, 'config')} to ${tilde(CONFIG_DIR)}: ${moved.join(', ')}. The old configs/ folder is no longer used.\n`);

  const [command, ...rest] = args.positionals;
  if (rest.length > (command === 'status' ? 1 : 0)) fail(`Unexpected argument: ${rest.at(-1)}. Run branch-graph --help for usage.`);

  if (command === 'init') {
    await init();
  } else if (command === 'install-skill') {
    const target = path.join(path.resolve(expandHome(opts.dir ?? path.join(os.homedir(), '.claude', 'skills'))), 'branch-graph');
    cpSync(path.join(ROOT, 'skills', 'branch-graph'), target, { recursive: true });
    console.log(`Installed the branch-graph skill in ${tilde(target)}`);
  } else if (command === 'demo') {
    console.log('Building example repos…');
    await serve(createDemo());
  } else if (command === 'status') {
    const file = await pickConfigFile(rest[0], { allowSetup: false });
    if (file) await status(file);
  } else {
    const file = await pickConfigFile(command, { allowSetup: true });
    if (file) await serve(file);
  }
} catch (err) {
  fail(`\n${err.message}`);
}
