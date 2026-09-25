import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatConfig } from './config.mjs';

// Fixed identity and settings so repos build the same on any machine or CI runner.
const GIT_OPTS = ['-c', 'user.name=Demo User', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export const daysAgo = (n) => Math.floor(Date.now() / 1000) - n * 86400;

let exitOnSignal = false;

/** A temp folder that is removed when the process exits, also on Ctrl+C. */
export function tempDir(prefix = 'branch-graph-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  if (!exitOnSignal) {
    exitOnSignal = true;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(130));
  }
  return dir;
}

/**
 * Build one repo: a bare "remote" plus a clone to commit in. Each commit is `step` seconds after the last.
 * Call push() at the end so the clone's origin/* branches match the remote.
 */
export function repoBuilder(root, name, { start = daysAgo(20), step = 3 * 3600 } = {}) {
  const remote = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  let time = start;
  let n = 0;

  const git = (cwd, ...args) => execFileSync('git', [...GIT_OPTS, ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();

  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);

  const api = {
    remote,
    work,
    checkout: (branch, from) => { git(work, 'checkout', '-q', ...(from ? ['-b', branch, from] : [branch])); return api; },
    commit: (message, author) => {
      writeFileSync(path.join(work, `file-${n++ % 5}.txt`), `${message}\n${time}\n`);
      git(work, 'add', '.');
      git(work, ...(author ? ['-c', `user.name=${author}`] : []), 'commit', '-q', '-m', message);
      time += step;
      return api;
    },
    merge: (from, message) => {
      git(work, 'merge', '--no-ff', '-q', '-m', message, from);
      time += step;
      return api;
    },
    wait: (seconds) => { time += seconds; return api; },
    /** Push branches and make `head` the remote's default branch. */
    push: (branches, head = branches[0]) => {
      git(work, 'push', '-q', 'origin', ...branches);
      git(remote, 'symbolic-ref', 'HEAD', `refs/heads/${head}`);
      git(work, 'fetch', '-q', 'origin');
      return api;
    },
  };
  return api;
}

const SUBJECTS = [
  'Add login page', 'Fix date parsing', 'Improve search ranking', 'Update dependencies', 'Add CSV export',
  'Refactor settings form', 'Fix flaky upload test', 'Add dark mode', 'Speed up dashboard query', 'Handle empty states',
  'Add audit log', 'Fix timezone bug', 'Add rate limiting', 'Improve error messages', 'Cache project list',
  'Add password reset', 'Fix pagination', 'Add health check', 'Clean up logging', 'Support SSO login',
];
const AUTHORS = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds', 'Margaret Hamilton'];

/** Small deterministic random numbers, so the demo looks the same every time. */
function random(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

/**
 * Three fake repos (Acme api, web, app) with about four weeks of history:
 * squash merges into development, merge promotions to test and main, and a few flow slips.
 * Returns the path of a config for them.
 */
export function createDemo(root = tempDir('branch-graph-demo-')) {
  const setups = [
    { name: 'acme-api', seed: 7, prodEvery: 9, hotfix: true },
    { name: 'acme-web', seed: 11, prodEvery: 7, directCommit: true },
    { name: 'acme-app', seed: 23, prodEvery: 11, featureMerge: true },
  ];
  let pr = 100;

  const repos = setups.map((s) => {
    const rand = random(s.seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const repo = repoBuilder(root, s.name, { start: daysAgo(28), step: 2 * 3600 })
      .commit('Initial commit', pick(AUTHORS))
      .checkout('development', 'main')
      .checkout('test', 'main')
      .checkout('development');

    for (let day = 1; day <= 27; day++) {
      const commits = Math.floor(rand() * 3);
      for (let i = 0; i < commits; i++) repo.commit(`${pick(SUBJECTS)} (#${pr++})`, pick(AUTHORS));
      if (s.directCommit && day === 12) repo.commit('Quick fix for typo', pick(AUTHORS));
      if (s.featureMerge && day === 16) {
        repo.checkout('feature/charts', 'development').commit('Try new chart library', pick(AUTHORS))
          .checkout('development').merge('feature/charts', `Merge pull request #${pr++} from acme/feature/charts`);
      }
      if (day % 4 === 0 && day < 26) repo.checkout('test').merge('development', `Merge pull request #${pr++} from acme/development`).checkout('development');
      if (day % s.prodEvery === 0) repo.checkout('main').merge('test', `Merge pull request #${pr++} from acme/test`).checkout('development');
      if (s.hotfix && day === 20) repo.checkout('main').commit(`Hotfix login redirect (#${pr++})`, pick(AUTHORS)).checkout('development');
      repo.wait(24 * 3600 - commits * 2 * 3600);
    }
    repo.push(['development', 'test', 'main', ...(s.featureMerge ? ['feature/charts'] : [])], 'development');
    return { name: s.name.replace(/^acme-/, ''), path: repo.work, branches: ['development', 'test', 'main'] };
  });

  const file = path.join(root, 'acme-demo.json');
  writeFileSync(file, formatConfig({ name: 'Acme (demo)', days: 30, flow: { integration: 'squash', promotion: 'merge' }, repos }));
  return file;
}
